-- 0245_opportunity_source_quota_bucket
--
-- Persistent, atomic Token-Bucket quota state per tenant and source.
-- Eliminates cross-process / concurrent cron race conditions using FOR UPDATE row locks.
-- Restricted strictly to service_role; authenticated users have SELECT-only.
-- Enforces composite foreign key to opportunity_source_configs to prevent orphaned buckets.

create table if not exists public.opportunity_source_quota_buckets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id text not null,
  tokens numeric(10, 2) not null default 100.00,
  capacity numeric(10, 2) not null default 100.00 check (capacity > 0),
  refill_rate_per_minute numeric(10, 2) not null default 10.00 check (refill_rate_per_minute > 0),
  last_refill_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint opportunity_source_quota_buckets_org_source_unique unique (organization_id, source_id),
  constraint opportunity_source_quota_buckets_tokens_non_negative check (tokens >= 0),
  constraint opportunity_source_quota_buckets_source_fk foreign key (organization_id, source_id)
    references public.opportunity_source_configs(organization_id, source_id) on delete cascade
);

create index if not exists opportunity_source_quota_buckets_lookup_idx
  on public.opportunity_source_quota_buckets (organization_id, source_id);

alter table public.opportunity_source_quota_buckets enable row level security;
alter table public.opportunity_source_quota_buckets force row level security;

drop policy if exists opportunity_source_quota_buckets_select on public.opportunity_source_quota_buckets;
create policy opportunity_source_quota_buckets_select on public.opportunity_source_quota_buckets
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

revoke all on public.opportunity_source_quota_buckets from public, anon, authenticated;
grant select on public.opportunity_source_quota_buckets to authenticated;
grant all on public.opportunity_source_quota_buckets to service_role;

create or replace function public.consume_opportunity_source_quota(
  p_organization_id uuid,
  p_source_id text,
  p_cost numeric default 1.0,
  p_capacity numeric default 100.0,
  p_refill_rate_per_minute numeric default 10.0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_default_cap numeric(10, 2);
  v_default_refill numeric(10, 2);
  v_tokens numeric(10, 2);
  v_capacity numeric(10, 2);
  v_refill_rate numeric(10, 2);
  v_last_refill_at timestamptz;
  v_now timestamptz;
  v_elapsed_seconds numeric;
  v_refilled_tokens numeric;
  v_available_tokens numeric;
  v_remaining_tokens numeric(10, 2);
  v_allowed boolean;
  v_deficit numeric;
  v_retry_after integer;
begin
  if p_organization_id is null then
    raise exception 'organization_id_required' using errcode = '22023';
  end if;
  if nullif(trim(p_source_id), '') is null then
    raise exception 'source_id_required' using errcode = '22023';
  end if;
  -- Não permitir consumo zero ou negativo: custo precisa ser estritamente positivo
  if p_cost is null or p_cost <= 0 then
    raise exception 'cost_must_be_positive' using errcode = '22023';
  end if;

  -- Defesa em profundidade: restrição estrita contra caller authenticated
  if auth.role() = 'authenticated' then
    raise exception 'opportunity_quota_mutation_forbidden' using errcode = '42501';
  end if;

  -- Valida se a fonte existe para a organização (evita buckets órfãos)
  if not exists (
    select 1 from public.opportunity_source_configs
    where organization_id = p_organization_id and source_id = p_source_id
  ) then
    raise exception 'opportunity_source_not_found' using errcode = 'P0002';
  end if;

  v_default_cap := round(greatest(1.0, coalesce(p_capacity, 100.0)), 2);
  v_default_refill := round(greatest(0.1, coalesce(p_refill_rate_per_minute, 10.0)), 2);

  -- Garante existência da linha sem falhar em concorrência
  insert into public.opportunity_source_quota_buckets (
    organization_id,
    source_id,
    tokens,
    capacity,
    refill_rate_per_minute,
    last_refill_at,
    updated_at
  ) values (
    p_organization_id,
    p_source_id,
    v_default_cap,
    v_default_cap,
    v_default_refill,
    clock_timestamp(),
    clock_timestamp()
  )
  on conflict (organization_id, source_id) do nothing;

  -- Trava a linha da partição (tenant + fonte) com FOR UPDATE para serializar execuções concorrentes
  select
    tokens,
    capacity,
    refill_rate_per_minute,
    last_refill_at
  into
    v_tokens,
    v_capacity,
    v_refill_rate,
    v_last_refill_at
  from public.opportunity_source_quota_buckets
  where organization_id = p_organization_id
    and source_id = p_source_id
  for update;

  v_now := clock_timestamp();
  v_elapsed_seconds := greatest(0.0, extract(epoch from (v_now - v_last_refill_at)));
  v_refilled_tokens := (v_elapsed_seconds / 60.0) * v_refill_rate;
  v_available_tokens := least(v_capacity, v_tokens + v_refilled_tokens);

  if v_available_tokens >= p_cost then
    v_allowed := true;
    v_remaining_tokens := round(greatest(0.0, v_available_tokens - p_cost), 2);
    v_retry_after := 0;
  else
    v_allowed := false;
    v_remaining_tokens := round(v_available_tokens, 2);
    v_deficit := p_cost - v_available_tokens;
    v_retry_after := greatest(1, ceil((v_deficit / v_refill_rate) * 60.0)::integer);
  end if;

  update public.opportunity_source_quota_buckets
  set
    tokens = v_remaining_tokens,
    last_refill_at = v_now,
    updated_at = v_now
  where organization_id = p_organization_id
    and source_id = p_source_id;

  -- Retorno alinhado com Cometa e Duna: expõe tokens_remaining e remainingTokens
  return jsonb_build_object(
    'allowed', v_allowed,
    'tokens_remaining', v_remaining_tokens,
    'remainingTokens', v_remaining_tokens,
    'cost', round(p_cost, 2),
    'retry_after_seconds', v_retry_after,
    'retryAfterSeconds', v_retry_after,
    'capacity', v_capacity,
    'refill_rate_per_minute', v_refill_rate,
    'refillRatePerMinute', v_refill_rate,
    'last_refill_at', v_now,
    'lastRefillAt', v_now
  );
end;
$$;

-- Somente service_role pode executar a RPC; anon e authenticated revogados
revoke all on function public.consume_opportunity_source_quota(uuid, text, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.consume_opportunity_source_quota(uuid, text, numeric, numeric, numeric) to service_role;

comment on table public.opportunity_source_quota_buckets is
  'Tenant + source token-bucket quota state; survives multiple processes and cron workers with atomic FOR UPDATE locking.';
comment on function public.consume_opportunity_source_quota(uuid, text, numeric, numeric, numeric) is
  'Atomic token-bucket quota consumption per tenant and source. Service_role only, with FOR UPDATE row locking and source existence check.';

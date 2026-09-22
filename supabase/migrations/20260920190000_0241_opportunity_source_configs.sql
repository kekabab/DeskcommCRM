-- 0241_opportunity_source_configs
--
-- Tenant-owned source registry and idempotent discovery sweep ledger.
-- Sources are configuration only: the worker may collect public feed data and
-- prepare Copilot proposals, but this schema has no outbound capability.

create table if not exists public.opportunity_source_configs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id text not null,
  name text not null,
  source_kind text not null,
  feed_url text not null,
  terms_url text not null,
  regions text[] not null default '{GLOBAL}'::text[],
  niche text not null default 'servicos_digitais',
  offer_key text not null default 'otimizacao_conversao_local',
  rate_limit_per_minute integer not null default 60 check (rate_limit_per_minute between 1 and 100000),
  max_records_per_run integer not null default 100 check (max_records_per_run between 1 and 100),
  is_active boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_source_configs_source_kind_check check (source_kind in ('open_data', 'official_api', 'tenant_first_party')),
  constraint opportunity_source_configs_source_id_check check (source_id ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  constraint opportunity_source_configs_feed_https check (feed_url ~ '^https://'),
  constraint opportunity_source_configs_terms_https check (terms_url ~ '^https://'),
  constraint opportunity_source_configs_org_source_unique unique (organization_id, source_id)
);

create table if not exists public.opportunity_discovery_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_config_id uuid not null references public.opportunity_source_configs(id) on delete cascade,
  source_id text not null,
  window_key text not null,
  status text not null default 'running',
  candidates_seen integer not null default 0,
  opportunities_created integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint opportunity_discovery_runs_status_check check (status in ('running', 'succeeded', 'failed', 'skipped')),
  constraint opportunity_discovery_runs_errors_object_check check (jsonb_typeof(errors) = 'array'),
  constraint opportunity_discovery_runs_org_source_fk foreign key (organization_id, source_id)
    references public.opportunity_source_configs(organization_id, source_id) on delete cascade,
  constraint opportunity_discovery_runs_org_source_window_unique unique (organization_id, source_id, window_key),
  constraint opportunity_discovery_runs_org_id_key unique (organization_id, id)
);

create index if not exists opportunity_source_configs_active_idx
  on public.opportunity_source_configs (organization_id, is_active, updated_at desc);
create index if not exists opportunity_discovery_runs_recent_idx
  on public.opportunity_discovery_runs (organization_id, started_at desc);

alter table public.opportunity_source_configs enable row level security;
alter table public.opportunity_discovery_runs enable row level security;

drop policy if exists opportunity_source_configs_select on public.opportunity_source_configs;
create policy opportunity_source_configs_select on public.opportunity_source_configs
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );
drop policy if exists opportunity_source_configs_write on public.opportunity_source_configs;
create policy opportunity_source_configs_write on public.opportunity_source_configs
  for all using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists opportunity_discovery_runs_select on public.opportunity_discovery_runs;
create policy opportunity_discovery_runs_select on public.opportunity_discovery_runs
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

revoke all on public.opportunity_source_configs, public.opportunity_discovery_runs from public, anon;
grant select, insert, update, delete on public.opportunity_source_configs to authenticated;
grant select on public.opportunity_discovery_runs to authenticated;
grant all on public.opportunity_source_configs, public.opportunity_discovery_runs to service_role;

drop trigger if exists trg_opportunity_source_configs_updated_at on public.opportunity_source_configs;
create trigger trg_opportunity_source_configs_updated_at
  before update on public.opportunity_source_configs
  for each row execute function public.fn_set_updated_at();

comment on table public.opportunity_source_configs is
  'Tenant-scoped authorized discovery sources. Collection creates proposals only; no outbound send.';
comment on table public.opportunity_discovery_runs is
  'Idempotent hourly discovery sweep ledger for source/tenant execution and observability.';

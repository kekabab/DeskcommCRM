-- 0240_opportunity_intelligence
--
-- Persistent contract for Opportunity Intelligence. This layer discovers and
-- qualifies opportunities; it does not duplicate crm_leads and it never sends
-- an outbound message from the database.

create table if not exists public.opportunity_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  linked_lead_id uuid references public.crm_leads(id) on delete set null,
  identity_key text not null,
  display_name text not null,
  domain text,
  region_key text,
  state text not null default 'discovered',
  confidence numeric(4,3) not null default 0 check (confidence >= 0 and confidence <= 1),
  signals jsonb not null default '[]'::jsonb,
  exception_code text,
  exception_message text,
  last_evaluated_at timestamptz,
  last_exception_at timestamptz,
  suppressed_at timestamptz,
  suppressed_reason text,
  suppressed_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_records_state_check check (state in (
    'discovered', 'validating', 'action_ready', 'awaiting_human',
    'contacted', 'engaged', 'converted', 'dismissed', 'suppressed', 'stale'
  )),
  constraint opportunity_records_identity_key_not_blank check (length(btrim(identity_key)) > 0),
  constraint opportunity_records_display_name_not_blank check (length(btrim(display_name)) > 0),
  constraint opportunity_records_signals_object_check check (jsonb_typeof(signals) = 'array'),
  constraint opportunity_records_org_id_key unique (organization_id, id)
);

create table if not exists public.opportunity_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  opportunity_id uuid not null,
  evidence_key text not null,
  source_id text not null,
  source_kind text not null,
  source_url text not null,
  terms_url text not null,
  policy_status text not null,
  claim text not null,
  signal_keys text[] not null default '{}'::text[],
  polarity text not null default 'supports',
  confidence numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  collected_at timestamptz not null,
  freshness_ttl_hours integer not null check (freshness_ttl_hours > 0),
  expires_at timestamptz generated always as (
    (((collected_at at time zone 'UTC') + freshness_ttl_hours * interval '1 hour') at time zone 'UTC')
  ) stored,
  created_at timestamptz not null default now(),
  constraint opportunity_evidence_opportunity_fk
    foreign key (organization_id, opportunity_id)
    references public.opportunity_records(organization_id, id) on delete cascade,
  constraint opportunity_evidence_source_kind_check check (source_kind in (
    'open_data', 'official_api', 'tenant_first_party', 'operator_verified'
  )),
  constraint opportunity_evidence_policy_status_check check (policy_status in (
    'verified_allowed', 'operator_reviewed', 'unknown'
  )),
  constraint opportunity_evidence_polarity_check check (polarity in ('supports', 'contradicts')),
  constraint opportunity_evidence_key_not_blank check (length(btrim(evidence_key)) > 0),
  constraint opportunity_evidence_claim_not_blank check (length(btrim(claim)) > 0),
  constraint opportunity_evidence_source_url_https check (source_url ~ '^https://'),
  constraint opportunity_evidence_terms_url_https check (terms_url is null or terms_url ~ '^https://'),
  constraint opportunity_evidence_org_key unique (organization_id, id)
);

create table if not exists public.opportunity_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  opportunity_id uuid not null,
  action text not null,
  status text not null default 'proposed',
  idempotency_key text not null,
  requires_human_approval boolean not null default true,
  pain_hypothesis text,
  target_offer text,
  proof_asset_summary text,
  evidence_keys text[] not null default '{}'::text[],
  reason text,
  created_by_user_id uuid references auth.users(id) on delete set null,
  approved_by_user_id uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  executed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint opportunity_actions_opportunity_fk
    foreign key (organization_id, opportunity_id)
    references public.opportunity_records(organization_id, id) on delete cascade,
  constraint opportunity_actions_action_check check (action in (
    'collect_more_evidence', 'refresh_evidence', 'prepare_personalized_draft',
    'request_human_review', 'link_existing_lead', 'suppress'
  )),
  constraint opportunity_actions_status_check check (status in (
    'proposed', 'approved', 'executed', 'blocked', 'rejected'
  )),
  constraint opportunity_actions_idempotency_key_not_blank check (length(btrim(idempotency_key)) > 0),
  constraint opportunity_actions_org_id_key unique (organization_id, id)
);

create table if not exists public.opportunity_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  opportunity_id uuid not null,
  action_id uuid,
  idempotency_key text not null,
  kind text not null,
  reason text,
  occurred_at timestamptz not null,
  metrics jsonb not null default '{}'::jsonb,
  created_by_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint opportunity_outcomes_opportunity_fk
    foreign key (organization_id, opportunity_id)
    references public.opportunity_records(organization_id, id) on delete cascade,
  constraint opportunity_outcomes_action_fk
    foreign key (organization_id, action_id)
    references public.opportunity_actions(organization_id, id) on delete set null,
  constraint opportunity_outcomes_kind_check check (kind in (
    'reply', 'meeting', 'deal_won', 'deal_lost', 'unsubscribed', 'ignored'
  )),
  constraint opportunity_outcomes_metrics_object_check check (jsonb_typeof(metrics) = 'object'),
  constraint opportunity_outcomes_idempotency_key_not_blank check (length(btrim(idempotency_key)) > 0),
  constraint opportunity_outcomes_org_id_key unique (organization_id, id)
);

-- Forward-fix safe for a partial install that created the table before the
-- generated freshness boundary was added to the contract.
alter table public.opportunity_evidence
  add column if not exists expires_at timestamptz generated always as (
    (((collected_at at time zone 'UTC') + freshness_ttl_hours * interval '1 hour') at time zone 'UTC')
  ) stored;
alter table public.opportunity_evidence
  alter column terms_url set not null;

create unique index if not exists opportunity_records_identity_unique
  on public.opportunity_records (organization_id, identity_key);

create unique index if not exists opportunity_evidence_key_unique
  on public.opportunity_evidence (organization_id, opportunity_id, evidence_key);

create unique index if not exists opportunity_actions_idempotency_unique
  on public.opportunity_actions (organization_id, idempotency_key);

create unique index if not exists opportunity_actions_open_unique
  on public.opportunity_actions (organization_id, opportunity_id)
  where status in ('proposed', 'approved');

create unique index if not exists opportunity_outcomes_idempotency_unique
  on public.opportunity_outcomes (organization_id, idempotency_key);

create index if not exists opportunity_records_radar_idx
  on public.opportunity_records (organization_id, state, confidence desc, updated_at desc);

create index if not exists opportunity_records_lead_idx
  on public.opportunity_records (organization_id, linked_lead_id)
  where linked_lead_id is not null;

create index if not exists opportunity_evidence_freshness_idx
  on public.opportunity_evidence (organization_id, opportunity_id, collected_at desc);

create index if not exists opportunity_evidence_expires_idx
  on public.opportunity_evidence (organization_id, opportunity_id, expires_at);

create index if not exists opportunity_actions_queue_idx
  on public.opportunity_actions (organization_id, status, created_at desc);

create index if not exists opportunity_outcomes_timeline_idx
  on public.opportunity_outcomes (organization_id, opportunity_id, occurred_at desc);

alter table public.opportunity_records enable row level security;
alter table public.opportunity_evidence enable row level security;
alter table public.opportunity_actions enable row level security;
alter table public.opportunity_outcomes enable row level security;

drop policy if exists opportunity_records_select on public.opportunity_records;
create policy opportunity_records_select on public.opportunity_records
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists opportunity_records_write on public.opportunity_records;
create policy opportunity_records_write on public.opportunity_records
  for all using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists opportunity_evidence_select on public.opportunity_evidence;
create policy opportunity_evidence_select on public.opportunity_evidence
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists opportunity_evidence_insert on public.opportunity_evidence;
drop policy if exists opportunity_evidence_write on public.opportunity_evidence;
create policy opportunity_evidence_write on public.opportunity_evidence
  for all using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists opportunity_actions_select on public.opportunity_actions;
create policy opportunity_actions_select on public.opportunity_actions
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists opportunity_actions_write on public.opportunity_actions;
create policy opportunity_actions_write on public.opportunity_actions
  for all using (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

drop policy if exists opportunity_outcomes_select on public.opportunity_outcomes;
create policy opportunity_outcomes_select on public.opportunity_outcomes
  for select using (
    public.fn_is_platform_admin()
    or organization_id in (select public.fn_user_org_ids())
  );

drop policy if exists opportunity_outcomes_insert on public.opportunity_outcomes;
create policy opportunity_outcomes_insert on public.opportunity_outcomes
  for insert with check (
    public.fn_is_platform_admin()
    or ((organization_id in (select public.fn_user_org_ids()))
        and public.fn_role_at_least(organization_id, 'manager'))
  );

revoke all on public.opportunity_records, public.opportunity_evidence,
  public.opportunity_actions, public.opportunity_outcomes from public, anon;
grant select, insert, update, delete on public.opportunity_records,
  public.opportunity_evidence, public.opportunity_actions, public.opportunity_outcomes
  to authenticated;
grant all on public.opportunity_records, public.opportunity_evidence,
  public.opportunity_actions, public.opportunity_outcomes to service_role;

create or replace function public.fn_opportunity_records_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.linked_lead_id is not null
     and not exists (
       select 1
       from public.crm_leads
       where id = new.linked_lead_id
         and organization_id = new.organization_id
     ) then
    raise exception 'opportunity_linked_lead_org_mismatch'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE'
     and old.state = 'suppressed'
     and new.state <> 'suppressed' then
    raise exception 'opportunity_suppressed_terminal'
      using errcode = '23514';
  end if;

  if new.state = 'suppressed' and new.suppressed_at is null then
    if tg_op = 'UPDATE' then
      new.suppressed_at := coalesce(old.suppressed_at, now());
    else
      new.suppressed_at := now();
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.fn_opportunity_records_guard() from public, anon;
grant execute on function public.fn_opportunity_records_guard() to authenticated, service_role;

drop trigger if exists trg_opportunity_records_updated_at on public.opportunity_records;
create trigger trg_opportunity_records_updated_at
  before update on public.opportunity_records
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_opportunity_records_guard on public.opportunity_records;
create trigger trg_opportunity_records_guard
  before insert or update on public.opportunity_records
  for each row execute function public.fn_opportunity_records_guard();

drop trigger if exists trg_opportunity_actions_updated_at on public.opportunity_actions;
create trigger trg_opportunity_actions_updated_at
  before update on public.opportunity_actions
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_opportunity_records_audit on public.opportunity_records;
create trigger trg_opportunity_records_audit
  after insert or update or delete on public.opportunity_records
  for each row execute function public.fn_audit_log_row();

drop trigger if exists trg_opportunity_evidence_audit on public.opportunity_evidence;
create trigger trg_opportunity_evidence_audit
  after insert or update or delete on public.opportunity_evidence
  for each row execute function public.fn_audit_log_row();

drop trigger if exists trg_opportunity_actions_audit on public.opportunity_actions;
create trigger trg_opportunity_actions_audit
  after insert or update or delete on public.opportunity_actions
  for each row execute function public.fn_audit_log_row();

drop trigger if exists trg_opportunity_outcomes_audit on public.opportunity_outcomes;
create trigger trg_opportunity_outcomes_audit
  after insert or update or delete on public.opportunity_outcomes
  for each row execute function public.fn_audit_log_row();

comment on table public.opportunity_records is
  'Opportunity Intelligence layer. Does not duplicate crm_leads; identity_key is tenant-scoped.';
comment on table public.opportunity_evidence is
  'Provenance for an opportunity. No raw page snapshots or unbounded personal data.';
comment on table public.opportunity_actions is
  'Internal proposals and review gates. action_ready never means outbound was sent.';
comment on table public.opportunity_outcomes is
  'Idempotent business outcomes used to learn and close the opportunity loop.';

notify pgrst, 'reload schema';

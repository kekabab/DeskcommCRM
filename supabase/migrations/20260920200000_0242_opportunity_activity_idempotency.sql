-- 0242_opportunity_activity_idempotency
--
-- The Opportunity Intelligence -> CRM timeline bridge is retryable. A process
-- may crash after inserting crm_lead_activities and before updating the
-- opportunity/action rows, so the idempotency key is enforced by PostgreSQL,
-- not only by the application lookup.

create unique index if not exists crm_lead_activities_opportunity_link_unique
  on public.crm_lead_activities (organization_id, (metadata->>'idempotency_key'))
  where source_module = 'opportunity_intelligence'
    and type = 'opportunity_linked'
    and metadata ? 'idempotency_key';

comment on index public.crm_lead_activities_opportunity_link_unique is
  'One retry-safe opportunity_linked timeline activity per organization and idempotency key.';

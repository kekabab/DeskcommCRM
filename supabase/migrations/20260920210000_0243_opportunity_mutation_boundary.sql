-- 0243_opportunity_mutation_boundary
--
-- Opportunity state is changed only by the server-side writer after the
-- deterministic domain decision. Authenticated PostgREST callers keep read
-- access for Radar/Dossier but cannot mutate records, evidence, actions or
-- outcomes directly around that writer.

revoke all on public.opportunity_records,
  public.opportunity_evidence, public.opportunity_actions,
  public.opportunity_outcomes from authenticated;
grant select on public.opportunity_records, public.opportunity_evidence,
  public.opportunity_actions, public.opportunity_outcomes to authenticated;

comment on table public.opportunity_records is
  'Opportunity Intelligence layer. Writes are server-side only; state transitions pass through the deterministic writer.';

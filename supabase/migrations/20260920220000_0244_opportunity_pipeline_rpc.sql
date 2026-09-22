-- 0244_opportunity_pipeline_rpc
--
-- The discovery writer sends one assessed pipeline plan to this SECURITY
-- DEFINER function. Each plan is persisted in one PostgreSQL transaction:
-- record, evidence, proposed action, canonical events and audit row. A
-- failed constraint rolls the complete batch back; a retry is harmless.

create unique index if not exists opportunity_event_log_idempotency_unique
  on public.event_log (
    organization_id,
    event_type,
    entity_kind,
    entity_id,
    (metadata->>'idempotency_key')
  )
  where entity_kind = 'opportunity'
    and metadata ? 'idempotency_key';

comment on index public.opportunity_event_log_idempotency_unique is
  'One retry-safe opportunity event per organization, type, entity and idempotency key.';

create or replace function public.persist_opportunity_pipeline_plan(
  p_plan jsonb,
  p_actor_user_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_organization_id uuid;
  v_trace_id text;
  v_item jsonb;
  v_assessment jsonb;
  v_candidate jsonb;
  v_identity jsonb;
  v_decision jsonb;
  v_action jsonb;
  v_event jsonb;
  v_evidence jsonb;
  v_existing_state text;
  v_opportunity_id uuid;
  v_action_id uuid;
  v_event_id uuid;
  v_record_state text;
  v_requested_state text;
  v_identity_key text;
  v_evidence_count integer;
  v_events_emitted integer;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_now timestamptz;
  v_metadata jsonb;
  v_inserted integer;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'opportunity_pipeline_plan_invalid' using errcode = '22023';
  end if;

  v_organization_id := nullif(p_plan->>'organization_id', '')::uuid;
  v_trace_id := nullif(btrim(p_plan->>'trace_id'), '');
  if v_organization_id is null or v_trace_id is null
     or coalesce((p_plan->>'schema_version')::integer, 0) <> 1
     or jsonb_typeof(p_plan->'items') <> 'array' then
    raise exception 'opportunity_pipeline_plan_invalid' using errcode = '22023';
  end if;

  -- Direct authenticated callers are not part of the public API, but the
  -- guard keeps the definer safe if the function is ever granted accidentally.
  if auth.uid() is not null
     and not public.fn_role_at_least(v_organization_id, 'manager') then
    raise exception 'caller_not_authorized_for_org'
      using hint = 'persist_opportunity_pipeline_plan: manager membership required';
  end if;

  for v_item in select value from jsonb_array_elements(p_plan->'items') loop
    v_assessment := v_item->'assessment';
    v_candidate := v_assessment->'candidate';
    v_identity := v_candidate->'identity';
    v_decision := v_item->'decision';
    v_action := v_item->'action_plan';
    v_identity_key := nullif(btrim(v_item->>'identity_key'), '');
    v_requested_state := nullif(v_decision->>'state', '');

    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_assessment) <> 'object'
       or jsonb_typeof(v_identity) <> 'object'
       or v_identity_key is null
       or v_requested_state is null then
      raise exception 'opportunity_pipeline_item_invalid' using errcode = '22023';
    end if;

    -- Lock an existing identity before deciding whether it is terminal.
    select state
      into v_existing_state
      from public.opportunity_records
     where organization_id = v_organization_id
       and identity_key = v_identity_key
     for update;

    if v_existing_state = 'suppressed' and v_requested_state <> 'suppressed' then
      select id into v_opportunity_id
        from public.opportunity_records
       where organization_id = v_organization_id
         and identity_key = v_identity_key;

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'opportunity_id', v_opportunity_id,
        'identity_key', v_identity_key,
        'state', 'suppressed',
        'action_id', null,
        'evidence_count', 0,
        'events_emitted', 0
      ));
      continue;
    end if;

    v_now := clock_timestamp();
    insert into public.opportunity_records (
      id,
      organization_id,
      linked_lead_id,
      identity_key,
      display_name,
      domain,
      region_key,
      state,
      confidence,
      signals,
      exception_code,
      exception_message,
      last_evaluated_at,
      suppressed_at,
      suppressed_reason,
      updated_at
    ) values (
      nullif(v_item->>'opportunity_id', '')::uuid,
      v_organization_id,
      nullif(v_decision->>'linked_lead_id', '')::uuid,
      v_identity_key,
      nullif(btrim(v_identity->>'display_name'), ''),
      nullif(btrim(v_identity->>'domain'), ''),
      null,
      v_requested_state,
      coalesce((v_decision->>'confidence')::numeric, 0),
      coalesce(v_assessment->'signals', '[]'::jsonb),
      nullif(v_decision->'exceptions'->0->>'code', ''),
      nullif(v_decision->'exceptions'->0->>'message', ''),
      v_now,
      case when v_requested_state = 'suppressed' then v_now else null end,
      case when v_requested_state = 'suppressed'
        then coalesce(nullif(v_decision->'exceptions'->0->>'message', ''), 'Tenant suppression list')
        else null
      end,
      v_now
    )
    on conflict (organization_id, identity_key) do update
      set linked_lead_id = excluded.linked_lead_id,
          display_name = excluded.display_name,
          domain = excluded.domain,
          region_key = excluded.region_key,
          state = excluded.state,
          confidence = excluded.confidence,
          signals = excluded.signals,
          exception_code = excluded.exception_code,
          exception_message = excluded.exception_message,
          last_evaluated_at = excluded.last_evaluated_at,
          suppressed_at = excluded.suppressed_at,
          suppressed_reason = excluded.suppressed_reason,
          updated_at = excluded.updated_at
      where public.opportunity_records.state <> 'suppressed'
         or excluded.state = 'suppressed'
    returning id, state into v_opportunity_id, v_record_state;

    -- A concurrent transaction may have won the identity race with a
    -- suppressed row. The terminal state wins even when the upsert returned no
    -- row because its WHERE clause rejected reopening.
    if v_opportunity_id is null then
      select id, state
        into v_opportunity_id, v_record_state
        from public.opportunity_records
       where organization_id = v_organization_id
         and identity_key = v_identity_key
       for update;
      if v_record_state = 'suppressed' and v_requested_state <> 'suppressed' then
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'opportunity_id', v_opportunity_id,
          'identity_key', v_identity_key,
          'state', 'suppressed',
          'action_id', null,
          'evidence_count', 0,
          'events_emitted', 0
        ));
        continue;
      end if;
    end if;

    v_evidence_count := 0;
    for v_evidence in select value from jsonb_array_elements(coalesce(v_assessment->'evidence', '[]'::jsonb)) loop
      insert into public.opportunity_evidence (
        organization_id,
        opportunity_id,
        evidence_key,
        source_id,
        source_kind,
        source_url,
        terms_url,
        policy_status,
        claim,
        signal_keys,
        polarity,
        confidence,
        collected_at,
        freshness_ttl_hours
      ) values (
        v_organization_id,
        v_opportunity_id,
        v_evidence->>'evidence_id',
        v_evidence->>'source_id',
        v_evidence->>'source_kind',
        v_evidence->>'source_url',
        v_evidence->>'terms_url',
        v_evidence->>'policy_status',
        v_evidence->>'claim',
        array(select jsonb_array_elements_text(coalesce(v_evidence->'signal_keys', '[]'::jsonb))),
        coalesce(v_evidence->>'polarity', 'supports'),
        (v_evidence->>'confidence')::numeric,
        (v_evidence->>'collected_at')::timestamptz,
        (v_evidence->>'freshness_ttl_hours')::integer
      )
      on conflict (organization_id, opportunity_id, evidence_key) do nothing;
      v_evidence_count := v_evidence_count + 1;
    end loop;

    v_action_id := null;
    if jsonb_typeof(v_action) = 'object' and v_requested_state <> 'suppressed' then
      insert into public.opportunity_actions (
        organization_id,
        opportunity_id,
        action,
        status,
        idempotency_key,
        requires_human_approval,
        pain_hypothesis,
        target_offer,
        proof_asset_summary,
        evidence_keys,
        reason,
        created_by_user_id
      ) values (
        v_organization_id,
        v_opportunity_id,
        v_action->>'action',
        'proposed',
        v_action->>'idempotency_key',
        true,
        v_action->>'pain_hypothesis',
        v_action->>'target_offer',
        v_action->>'proof_asset_summary',
        array(select jsonb_array_elements_text(coalesce(v_action->'evidence_keys', '[]'::jsonb))),
        v_action->>'reason',
        p_actor_user_id
      )
      on conflict (organization_id, idempotency_key) do nothing
      returning id into v_action_id;

      if v_action_id is null then
        select id into v_action_id
          from public.opportunity_actions
         where organization_id = v_organization_id
           and idempotency_key = v_action->>'idempotency_key';
      end if;

      if v_action_id is null then
        select id into v_action_id
          from public.opportunity_actions
         where organization_id = v_organization_id
           and opportunity_id = v_opportunity_id
           and status in ('proposed', 'approved')
         limit 1;
      end if;
    end if;

    v_events_emitted := 0;
    for v_event in select value from jsonb_array_elements(coalesce(v_item->'events', '[]'::jsonb)) loop
      v_metadata := coalesce(v_event->'metadata', '{}'::jsonb);
      if nullif(v_metadata->>'idempotency_key', '') is null then
        raise exception 'opportunity_event_idempotency_key_required' using errcode = '22023';
      end if;

      insert into public.event_log (
        organization_id,
        event_type,
        entity_kind,
        entity_id,
        payload,
        metadata
      ) values (
        v_organization_id,
        v_event->>'event_type',
        'opportunity',
        v_opportunity_id,
        coalesce(v_event->'payload', '{}'::jsonb) || jsonb_build_object('opportunity_id', v_opportunity_id),
        v_metadata || jsonb_build_object('emitted_at', extract(epoch from clock_timestamp()))
      )
      on conflict (organization_id, event_type, entity_kind, entity_id, (metadata->>'idempotency_key'))
      where entity_kind = 'opportunity' and metadata ? 'idempotency_key'
      do nothing;

      get diagnostics v_inserted = row_count;
      v_events_emitted := v_events_emitted + v_inserted;
    end loop;

    insert into public.api_audit_log (
      organization_id,
      actor_user_id,
      action,
      resource_type,
      resource_id
    ) values (
      v_organization_id,
      p_actor_user_id,
      'opportunity.evaluated',
      'opportunity_records',
      v_opportunity_id
    );

    v_result := jsonb_build_object(
      'opportunity_id', v_opportunity_id,
      'identity_key', v_identity_key,
      'state', v_record_state,
      'action_id', v_action_id,
      'evidence_count', v_evidence_count,
      'events_emitted', v_events_emitted
    );
    v_results := v_results || jsonb_build_array(v_result);
  end loop;

  return jsonb_build_object(
    'trace_id', v_trace_id,
    'organization_id', v_organization_id,
    'persisted_count', jsonb_array_length(v_results),
    'results', v_results
  );
end;
$$;

revoke all on function public.persist_opportunity_pipeline_plan(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.persist_opportunity_pipeline_plan(jsonb, uuid) to service_role;

comment on function public.persist_opportunity_pipeline_plan(jsonb, uuid) is
  'Atomic, retry-safe Opportunity Intelligence plan persistence. Copilot-only; never sends outbound.';

notify pgrst, 'reload schema';

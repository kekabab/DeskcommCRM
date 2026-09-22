import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

import {
  applyOutcome,
  type OpportunityOutcome,
  type OpportunityOutcomeKind,
  type OpportunityState,
} from "@/lib/opportunity-intelligence/domain";
import type {
  OpportunityPipelineAssessment,
  OpportunityPipelinePlan,
} from "@/lib/opportunity-intelligence/pipeline";

export type PersistOpportunityResult = {
  opportunity_id: string;
  identity_key: string;
  state: OpportunityState;
  action_id: string | null;
  evidence_count: number;
  events_emitted: number;
};

export type PersistPipelinePlanResult = {
  trace_id: string;
  organization_id: string;
  persisted_count: number;
  results: PersistOpportunityResult[];
};

export type RecordOutcomeInput = {
  organization_id: string;
  opportunity_id: string;
  action_id?: string | null;
  idempotency_key: string;
  kind: OpportunityOutcomeKind;
  reason?: string | null;
  metrics?: Record<string, string | number | boolean>;
  user_id?: string | null;
  occurred_at?: string;
};

export type RecordOutcomeResult = {
  outcome_id: string;
  opportunity_id: string;
  previous_state: OpportunityState;
  new_state: OpportunityState;
  event_emitted: boolean;
};

async function findOpportunityEvent(
  client: SupabaseClient,
  input: {
    organization_id: string;
    event_type: string;
    opportunity_id: string;
    idempotency_key: string;
  },
) {
  const { data, error } = await client
    .from("event_log")
    .select("id")
    .eq("organization_id", input.organization_id)
    .eq("event_type", input.event_type)
    .eq("entity_id", input.opportunity_id)
    .eq("metadata->>idempotency_key", input.idempotency_key)
    .maybeSingle();

  if (error) throw new Error(`event_log_lookup_failed: ${error.message}`);
  return data;
}

async function emitOpportunityEvent(
  client: SupabaseClient,
  organizationId: string,
  opportunityId: string,
  envelope: {
    event_type: string;
    entity_kind: string;
    payload: Record<string, unknown>;
    metadata: Record<string, unknown>;
  },
) {
  const { error } = await client.rpc(
    "emit_event" as never,
    {
      p_event_type: envelope.event_type,
      p_entity_kind: envelope.entity_kind,
      p_entity_id: opportunityId,
      p_payload: { ...envelope.payload, opportunity_id: opportunityId },
      p_metadata: envelope.metadata,
      p_organization_id: organizationId,
    } as never,
  );

  if (error) {
    // The 0244 functional unique index closes the last concurrent replay race.
    // If another worker won the insert between our lookup and emit, the event
    // is already durable and the caller can safely continue.
    if (error.message.includes("opportunity_event_log_idempotency_unique")) {
      const existingEvent = await findOpportunityEvent(client, {
        organization_id: organizationId,
        event_type: envelope.event_type,
        opportunity_id: opportunityId,
        idempotency_key: String(envelope.metadata.idempotency_key),
      });
      if (existingEvent) return;
    }
    throw new Error(`event_log_emit_failed: ${error.message}`);
  }
}

async function ensureActionReadyEvent(
  client: SupabaseClient,
  input: { organization_id: string; action_id: string; opportunity_id: string },
  action: { action: string; confidence: number },
): Promise<boolean> {
  const idempotencyKey = `action-approved-${input.action_id}`;
  const existingEvent = await findOpportunityEvent(client, {
    organization_id: input.organization_id,
    event_type: "opportunity.ready_for_action",
    opportunity_id: input.opportunity_id,
    idempotency_key: idempotencyKey,
  });
  if (existingEvent) return false;

  await emitOpportunityEvent(client, input.organization_id, input.opportunity_id, {
    event_type: "opportunity.ready_for_action",
    entity_kind: "opportunity",
    payload: {
      trace_id: "action-approval",
      schema_version: 1,
      organization_id: input.organization_id,
      opportunity_id: input.opportunity_id,
      state: "action_ready",
      action: action.action,
      confidence: action.confidence,
      requires_human: false,
      exception_codes: [],
      evidence_ids: [],
    },
    metadata: {
      idempotency_key: idempotencyKey,
      source_id: "operator-approval",
      external_id: input.action_id,
      duplicate_source_ids: [],
    },
  });
  return true;
}

/**
 * Persists a full OpportunityPipelinePlan through the Postgres transaction
 * boundary. The RPC owns record/evidence/action/event/audit atomicity; the
 * TypeScript layer only serializes the already-assessed, evidence-backed plan
 * and validates the response shape.
 */
export async function persistOpportunityPipelinePlan(
  client: SupabaseClient,
  plan: OpportunityPipelinePlan,
  assessments: OpportunityPipelineAssessment[],
  options?: { actor_user_id?: string | null },
): Promise<PersistPipelinePlanResult> {
  const assessmentByOpportunityId = new Map(
    assessments.map((assessment) => [assessment.opportunity_id, assessment]),
  );

  const rpcPlan = {
    ...plan,
    items: plan.items.map((item) => {
      const assessment = assessmentByOpportunityId.get(item.opportunity_id);
      if (!assessment) {
        throw new Error(`Assessment missing for opportunity ${item.opportunity_id}`);
      }

      return {
        ...item,
        assessment: {
          candidate: assessment.candidate,
          signals: assessment.signals,
          evidence: assessment.evidence,
        },
      };
    }),
  };

  const { data, error } = await client.rpc(
    "persist_opportunity_pipeline_plan" as never,
    {
      p_plan: rpcPlan,
      p_actor_user_id: options?.actor_user_id ?? null,
    } as never,
  );

  if (error) {
    throw new Error(`opportunity_pipeline_persist_rpc_failed: ${error.message}`);
  }

  const parsed = typeof data === "string" ? JSON.parse(data) : data;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { results?: unknown }).results)
  ) {
    throw new Error("opportunity_pipeline_persist_rpc_invalid_response");
  }

  const results = (parsed as { results: PersistOpportunityResult[] }).results;
  return {
    trace_id: plan.trace_id,
    organization_id: plan.organization_id,
    persisted_count: results.length,
    results,
  };
}

/**
 * Records an outcome (response, meeting, won, lost, unsubscribe, ignored),
 * updating opportunity_records state and emitting opportunity.outcome_recorded.
 */
export async function recordOpportunityOutcome(
  client: SupabaseClient,
  input: RecordOutcomeInput,
): Promise<RecordOutcomeResult> {
  // A replay with the same idempotency key is a no-op. This check happens
  // before state mutation so retries cannot advance the state twice or emit a
  // second outcome event.
  const { data: existingOutcome, error: existingOutcomeError } = await client
    .from("opportunity_outcomes")
    .select("id, opportunity_id, action_id, kind, reason, occurred_at, metrics")
    .eq("organization_id", input.organization_id)
    .eq("idempotency_key", input.idempotency_key)
    .maybeSingle();

  if (existingOutcomeError) {
    throw new Error(`opportunity_outcome_lookup_failed: ${existingOutcomeError.message}`);
  }

  if (existingOutcome) {
    const { data: currentRecord, error: currentRecordError } = await client
      .from("opportunity_records")
      .select("state")
      .eq("organization_id", input.organization_id)
      .eq("id", input.opportunity_id)
      .single();

    if (currentRecordError || !currentRecord) {
      throw new Error(`opportunity_not_found: ${currentRecordError?.message ?? "Record missing"}`);
    }

    const replayOutcome: OpportunityOutcome = {
      outcome_id: existingOutcome.id,
      organization_id: input.organization_id,
      opportunity_id: input.opportunity_id,
      action_id: existingOutcome.action_id ?? input.action_id ?? null,
      kind: existingOutcome.kind as OpportunityOutcomeKind,
      reason: existingOutcome.reason ?? input.reason ?? null,
      occurred_at: existingOutcome.occurred_at ?? input.occurred_at ?? new Date().toISOString(),
      metrics: (existingOutcome.metrics ?? input.metrics ?? {}) as Record<
        string,
        string | number | boolean
      >,
    };
    const replayPreviousState = currentRecord.state as OpportunityState;
    const replayNewState = applyOutcome(replayPreviousState, replayOutcome);

    if (replayPreviousState !== replayNewState) {
      const replayUpdatePayload: Record<string, unknown> = {
        state: replayNewState,
        updated_at: new Date().toISOString(),
      };
      if (replayOutcome.kind === "unsubscribed") {
        replayUpdatePayload.suppressed_at = new Date().toISOString();
        replayUpdatePayload.suppressed_reason =
          replayOutcome.reason ?? "Recipient requested opt-out";
      }
      const { error: replayUpdateError } = await client
        .from("opportunity_records")
        .update(replayUpdatePayload)
        .eq("organization_id", input.organization_id)
        .eq("id", input.opportunity_id);
      if (replayUpdateError) {
        throw new Error(`opportunity_record_state_reconcile_failed: ${replayUpdateError.message}`);
      }
    }

    if (replayOutcome.action_id) {
      const { error: replayActionError } = await client
        .from("opportunity_actions")
        .update({
          status: "executed",
          executed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", input.organization_id)
        .eq("id", replayOutcome.action_id);
      if (replayActionError) {
        throw new Error(`opportunity_action_state_reconcile_failed: ${replayActionError.message}`);
      }
    }

    const replayEventType = "opportunity.outcome_recorded";
    const existingReplayEvent = await findOpportunityEvent(client, {
      organization_id: input.organization_id,
      event_type: replayEventType,
      opportunity_id: input.opportunity_id,
      idempotency_key: input.idempotency_key,
    });
    let replayEventEmitted = false;
    if (!existingReplayEvent) {
      await emitOpportunityEvent(client, input.organization_id, input.opportunity_id, {
        event_type: replayEventType,
        entity_kind: "opportunity",
        payload: {
          trace_id: "replay",
          schema_version: 1,
          organization_id: input.organization_id,
          opportunity_id: input.opportunity_id,
          outcome_id: replayOutcome.outcome_id,
          kind: replayOutcome.kind,
          previous_state: replayPreviousState,
          new_state: replayNewState,
          reason: replayOutcome.reason,
          state: replayNewState,
          action: "record_outcome",
          confidence: 1,
          requires_human: false,
          exception_codes: [],
          evidence_ids: [],
        },
        metadata: {
          idempotency_key: input.idempotency_key,
          source_id: "outcome",
          external_id: input.idempotency_key,
          duplicate_source_ids: [],
        },
      });
      replayEventEmitted = true;
    }

    return {
      outcome_id: existingOutcome.id,
      opportunity_id: input.opportunity_id,
      previous_state: replayPreviousState,
      new_state: replayNewState,
      event_emitted: replayEventEmitted,
    };
  }

  // 1. Fetch current opportunity state
  const { data: record, error: fetchError } = await client
    .from("opportunity_records")
    .select("id, state, organization_id")
    .eq("organization_id", input.organization_id)
    .eq("id", input.opportunity_id)
    .single();

  if (fetchError || !record) {
    throw new Error(`opportunity_not_found: ${fetchError?.message ?? "Record missing"}`);
  }

  const previousState = record.state as OpportunityState;

  // Invariant: suppressed is terminal
  if (previousState === "suppressed") {
    throw new Error("cannot_record_outcome_on_suppressed_opportunity");
  }

  const outcomeModel: OpportunityOutcome = {
    outcome_id: randomUUID(),
    organization_id: input.organization_id,
    opportunity_id: input.opportunity_id,
    action_id: input.action_id ?? null,
    kind: input.kind,
    reason: input.reason ?? null,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    metrics: input.metrics ?? {},
  };

  const newState = applyOutcome(previousState, outcomeModel);

  // 2. Insert outcome idempotently
  const outcomeRow = {
    organization_id: input.organization_id,
    opportunity_id: input.opportunity_id,
    action_id: input.action_id ?? null,
    idempotency_key: input.idempotency_key,
    kind: input.kind,
    reason: input.reason ?? null,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    metrics: input.metrics ?? {},
    created_by_user_id: input.user_id ?? null,
  };

  const { data: savedOutcome, error: outcomeError } = await client
    .from("opportunity_outcomes")
    .upsert(outcomeRow, {
      onConflict: "organization_id, idempotency_key",
      ignoreDuplicates: true,
    })
    .select("id")
    .maybeSingle();

  if (outcomeError) {
    throw new Error(`opportunity_outcome_insert_failed: ${outcomeError.message}`);
  }

  if (!savedOutcome) {
    const { data: racedOutcome, error: racedOutcomeError } = await client
      .from("opportunity_outcomes")
      .select("id")
      .eq("organization_id", input.organization_id)
      .eq("idempotency_key", input.idempotency_key)
      .single();

    if (racedOutcomeError || !racedOutcome) {
      throw new Error(
        `opportunity_outcome_insert_failed: ${racedOutcomeError?.message ?? "Outcome missing after upsert"}`,
      );
    }

    return {
      outcome_id: racedOutcome.id,
      opportunity_id: input.opportunity_id,
      previous_state: previousState,
      new_state: previousState,
      event_emitted: false,
    };
  }

  // 3. Update opportunity record state
  const updatePayload: Record<string, unknown> = {
    state: newState,
    updated_at: new Date().toISOString(),
  };

  if (input.kind === "unsubscribed") {
    updatePayload.suppressed_at = new Date().toISOString();
    updatePayload.suppressed_reason = input.reason ?? "Recipient requested opt-out";
  }

  const { error: updateError } = await client
    .from("opportunity_records")
    .update(updatePayload)
    .eq("organization_id", input.organization_id)
    .eq("id", input.opportunity_id);

  if (updateError) {
    throw new Error(`opportunity_record_state_update_failed: ${updateError.message}`);
  }

  // 4. Update linked action to executed if provided
  if (input.action_id) {
    const { error: actionUpdateError } = await client
      .from("opportunity_actions")
      .update({
        status: "executed",
        executed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", input.organization_id)
      .eq("id", input.action_id);
    if (actionUpdateError) {
      throw new Error(`opportunity_action_state_update_failed: ${actionUpdateError.message}`);
    }
  }

  // 5. Emit opportunity.outcome_recorded event
  await emitOpportunityEvent(client, input.organization_id, input.opportunity_id, {
    event_type: "opportunity.outcome_recorded",
    entity_kind: "opportunity",
    payload: {
      trace_id: "outcome",
      schema_version: 1,
      organization_id: input.organization_id,
      opportunity_id: input.opportunity_id,
      outcome_id: savedOutcome.id,
      kind: input.kind,
      previous_state: previousState,
      new_state: newState,
      reason: input.reason ?? null,
      state: newState,
      action: "record_outcome",
      confidence: 1,
      requires_human: false,
      exception_codes: [],
      evidence_ids: [],
      signal_keys: [input.kind],
    },
    metadata: {
      idempotency_key: input.idempotency_key,
      source_id: "outcome",
      external_id: input.idempotency_key,
      duplicate_source_ids: [],
    },
  });

  return {
    outcome_id: savedOutcome.id,
    opportunity_id: input.opportunity_id,
    previous_state: previousState,
    new_state: newState,
    event_emitted: true,
  };
}

export type ReviewOpportunityActionInput = {
  organization_id: string;
  action_id: string;
  status: "approved" | "rejected";
  user_id: string;
  reason?: string | null;
  lead_id?: string | null;
};

export type ReviewOpportunityActionResult = {
  action_id: string;
  opportunity_id: string;
  status: "approved" | "rejected" | "executed";
  previous_status: string;
  opportunity_state: OpportunityState;
  event_emitted: boolean;
};

export async function reviewOpportunityAction(
  client: SupabaseClient,
  input: ReviewOpportunityActionInput,
): Promise<ReviewOpportunityActionResult> {
  const { data: action, error: actionError } = await client
    .from("opportunity_actions")
    .select("id, opportunity_id, status, reason, action, idempotency_key, evidence_keys")
    .eq("organization_id", input.organization_id)
    .eq("id", input.action_id)
    .single();

  if (actionError || !action) {
    throw new Error(`opportunity_action_not_found: ${actionError?.message ?? "Action missing"}`);
  }

  const previousStatus = action.status;
  if (previousStatus === input.status) {
    const { data: rec } = await client
      .from("opportunity_records")
      .select("state, confidence")
      .eq("organization_id", input.organization_id)
      .eq("id", action.opportunity_id)
      .single();

    let eventEmitted = false;
    if (input.status === "approved" && rec?.state === "action_ready") {
      eventEmitted = await ensureActionReadyEvent(
        client,
        {
          organization_id: input.organization_id,
          action_id: action.id,
          opportunity_id: action.opportunity_id,
        },
        { action: action.action, confidence: Number(rec?.confidence ?? 0) },
      );
    }

    return {
      action_id: action.id,
      opportunity_id: action.opportunity_id,
      status: input.status,
      previous_status: previousStatus,
      opportunity_state: (rec?.state ?? "action_ready") as OpportunityState,
      event_emitted: eventEmitted,
    };
  }

  if (previousStatus === "executed") {
    throw new Error("cannot_modify_executed_action");
  }
  if (previousStatus === "blocked") {
    throw new Error("cannot_modify_blocked_action");
  }

  const { data: record, error: recordError } = await client
    .from("opportunity_records")
    .select("id, state, confidence, display_name, domain, linked_lead_id")
    .eq("organization_id", input.organization_id)
    .eq("id", action.opportunity_id)
    .single();

  if (recordError || !record) {
    throw new Error(`opportunity_not_found: ${recordError?.message ?? "Record missing"}`);
  }

  if (record.state === "suppressed") {
    throw new Error("cannot_modify_action_for_suppressed_opportunity");
  }

  // Evidence can expire between proposal and the operator's click. Never
  // promote a personalized draft from stale proof; the next safe action is a
  // refresh/review, not a silent approval of an old claim.
  if (input.status === "approved" && action.action === "prepare_personalized_draft") {
    const evidenceKeys = Array.isArray(action.evidence_keys)
      ? action.evidence_keys.filter((key): key is string => typeof key === "string")
      : [];
    for (const evidenceKey of evidenceKeys) {
      const { data: evidence, error: evidenceError } = await client
        .from("opportunity_evidence")
        .select("id, expires_at")
        .eq("organization_id", input.organization_id)
        .eq("opportunity_id", action.opportunity_id)
        .eq("evidence_key", evidenceKey)
        .maybeSingle();

      if (evidenceError) {
        throw new Error(`opportunity_evidence_lookup_failed: ${evidenceError.message}`);
      }
      if (
        !evidence ||
        Number.isNaN(Date.parse(String(evidence.expires_at))) ||
        Date.parse(String(evidence.expires_at)) <= Date.now()
      ) {
        throw new Error("opportunity_evidence_stale_at_approval");
      }
    }
  }

  const nowIso = new Date().toISOString();
  let finalActionStatus: "approved" | "rejected" | "executed" = input.status;
  const targetLeadId = input.lead_id ?? (record.linked_lead_id as string | null);

  // Special handling for linking to existing lead on approval
  if (input.status === "approved" && action.action === "link_existing_lead" && targetLeadId) {
    const activityIdempotencyKey = `opp-link-${action.opportunity_id}-${targetLeadId}`;
    const { data: existingActivity, error: activityLookupError } = await client
      .from("crm_lead_activities")
      .select("id")
      .eq("organization_id", input.organization_id)
      .eq("metadata->>idempotency_key", activityIdempotencyKey)
      .maybeSingle();

    if (activityLookupError) {
      throw new Error(`crm_lead_activity_lookup_failed: ${activityLookupError.message}`);
    }

    if (!existingActivity) {
      const { error: activityError } = await client.from("crm_lead_activities").insert({
        organization_id: input.organization_id,
        lead_id: targetLeadId,
        source_module: "opportunity_intelligence",
        source_id: action.opportunity_id,
        type: "opportunity_linked",
        payload: {
          opportunity_id: action.opportunity_id,
          display_name: record.display_name,
          domain: record.domain,
          action_id: action.id,
          reason: input.reason ?? null,
        },
        metadata: { idempotency_key: activityIdempotencyKey },
        performed_at: nowIso,
        performed_by_user_id: input.user_id,
      });

      if (activityError) {
        throw new Error(`crm_lead_activity_insert_failed: ${activityError.message}`);
      }
    }

    finalActionStatus = "executed";
  }

  const actionUpdate: Record<string, unknown> = {
    status: finalActionStatus,
    updated_at: nowIso,
  };

  if (input.status === "approved") {
    actionUpdate.approved_by_user_id = input.user_id;
    actionUpdate.approved_at = nowIso;
    if (finalActionStatus === "executed") {
      actionUpdate.executed_at = nowIso;
    }
  }
  if (input.reason) {
    actionUpdate.reason = input.reason;
  }

  const { error: updateActionError } = await client
    .from("opportunity_actions")
    .update(actionUpdate)
    .eq("organization_id", input.organization_id)
    .eq("id", input.action_id);

  if (updateActionError) {
    throw new Error(`opportunity_action_update_failed: ${updateActionError.message}`);
  }

  let newRecordState: OpportunityState = record.state as OpportunityState;
  if (input.status === "approved" && record.state === "awaiting_human") {
    newRecordState = "action_ready";
  } else if (input.status === "rejected") {
    newRecordState = "dismissed";
  }

  const recordUpdate: Record<string, unknown> = {
    state: newRecordState,
    updated_at: nowIso,
  };
  if (input.status === "rejected") {
    recordUpdate.exception_message = input.reason ?? "Ação rejeitada pelo operador";
  } else if (finalActionStatus === "executed" && targetLeadId) {
    recordUpdate.linked_lead_id = targetLeadId;
    recordUpdate.exception_code = null;
    recordUpdate.exception_message = null;
  }

  const { error: updateRecordError } = await client
    .from("opportunity_records")
    .update(recordUpdate)
    .eq("organization_id", input.organization_id)
    .eq("id", action.opportunity_id);

  if (updateRecordError) {
    throw new Error(`opportunity_record_state_update_failed: ${updateRecordError.message}`);
  }

  let eventEmitted = false;
  if (newRecordState === "action_ready") {
    eventEmitted = await ensureActionReadyEvent(
      client,
      {
        organization_id: input.organization_id,
        action_id: action.id,
        opportunity_id: action.opportunity_id,
      },
      { action: action.action, confidence: Number(record.confidence ?? 0) },
    );
  }

  return {
    action_id: action.id,
    opportunity_id: action.opportunity_id,
    status: finalActionStatus,
    previous_status: previousStatus,
    opportunity_state: newRecordState,
    event_emitted: eventEmitted,
  };
}

export type LinkOpportunityToLeadInput = {
  organization_id: string;
  opportunity_id: string;
  lead_id: string;
  action_id?: string | null;
  user_id?: string | null;
  reason?: string | null;
};

export type LinkOpportunityToLeadResult = {
  activity_id: string;
  opportunity_id: string;
  lead_id: string;
  action_id: string | null;
  previous_state: OpportunityState;
  new_state: OpportunityState;
  event_emitted: boolean;
};

export async function linkOpportunityToLead(
  client: SupabaseClient,
  input: LinkOpportunityToLeadInput,
): Promise<LinkOpportunityToLeadResult> {
  const { data: record, error: recordError } = await client
    .from("opportunity_records")
    .select("id, state, confidence, display_name, domain")
    .eq("organization_id", input.organization_id)
    .eq("id", input.opportunity_id)
    .single();

  if (recordError || !record) {
    throw new Error(`opportunity_not_found: ${recordError?.message ?? "Record missing"}`);
  }

  if (record.state === "suppressed") {
    throw new Error("cannot_link_suppressed_opportunity");
  }

  const previousState = record.state as OpportunityState;
  const nowIso = new Date().toISOString();

  // 1. Insert activity into crm_lead_activities exactly once. This lookup
  // makes a retry safe even if the process crashed after the activity insert
  // and before the opportunity/action updates.
  const activityIdempotencyKey = `opp-link-${input.opportunity_id}-${input.lead_id}`;
  const { data: existingActivity, error: activityLookupError } = await client
    .from("crm_lead_activities")
    .select("id")
    .eq("organization_id", input.organization_id)
    .eq("metadata->>idempotency_key", activityIdempotencyKey)
    .maybeSingle();

  if (activityLookupError) {
    throw new Error(`crm_lead_activity_lookup_failed: ${activityLookupError.message}`);
  }

  let activityId = existingActivity?.id as string | null | undefined;
  if (!activityId) {
    const { data: activity, error: activityError } = await client
      .from("crm_lead_activities")
      .insert({
        organization_id: input.organization_id,
        lead_id: input.lead_id,
        source_module: "opportunity_intelligence",
        source_id: input.opportunity_id,
        type: "opportunity_linked",
        payload: {
          opportunity_id: input.opportunity_id,
          display_name: record.display_name,
          domain: record.domain,
          action_id: input.action_id ?? null,
          reason: input.reason ?? null,
        },
        metadata: { idempotency_key: activityIdempotencyKey },
        performed_at: nowIso,
        performed_by_user_id: input.user_id ?? null,
      })
      .select("id")
      .single();

    if (activityError || !activity) {
      throw new Error(
        `crm_lead_activity_insert_failed: ${activityError?.message ?? "Insert failed"}`,
      );
    }
    activityId = activity.id as string;
  }

  // 2. Update opportunity record: set linked_lead_id and transition to action_ready if awaiting_human
  const newState: OpportunityState =
    previousState === "awaiting_human" ? "action_ready" : previousState;
  const { error: updateRecordError } = await client
    .from("opportunity_records")
    .update({
      linked_lead_id: input.lead_id,
      state: newState,
      exception_code: null,
      exception_message: null,
      updated_at: nowIso,
    })
    .eq("organization_id", input.organization_id)
    .eq("id", input.opportunity_id);

  if (updateRecordError) {
    throw new Error(`opportunity_record_update_failed: ${updateRecordError.message}`);
  }

  // 3. Mark link_existing_lead action as executed if present
  let resolvedActionId = input.action_id ?? null;
  if (!resolvedActionId) {
    const { data: openAction } = await client
      .from("opportunity_actions")
      .select("id")
      .eq("organization_id", input.organization_id)
      .eq("opportunity_id", input.opportunity_id)
      .eq("action", "link_existing_lead")
      .in("status", ["proposed", "approved"])
      .maybeSingle();
    resolvedActionId = openAction?.id ?? null;
  }

  if (resolvedActionId) {
    const { error: updateActionError } = await client
      .from("opportunity_actions")
      .update({
        status: "executed",
        executed_at: nowIso,
        updated_at: nowIso,
      })
      .eq("organization_id", input.organization_id)
      .eq("id", resolvedActionId);

    if (updateActionError) {
      throw new Error(`opportunity_action_update_failed: ${updateActionError.message}`);
    }
  }

  // 4. Emit ready_for_action event if moved to action_ready
  let eventEmitted = false;
  if (newState === "action_ready") {
    eventEmitted = await ensureActionReadyEvent(
      client,
      {
        organization_id: input.organization_id,
        action_id: resolvedActionId ?? `link-${input.lead_id}`,
        opportunity_id: input.opportunity_id,
      },
      { action: "link_existing_lead", confidence: Number(record.confidence ?? 0) },
    );
  }

  return {
    activity_id: activityId as string,
    opportunity_id: input.opportunity_id,
    lead_id: input.lead_id,
    action_id: resolvedActionId,
    previous_state: previousState,
    new_state: newState,
    event_emitted: eventEmitted,
  };
}

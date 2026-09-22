import { z } from "zod";

import {
  buildOpportunityIdempotencyKey,
  canonicalIdentityKey,
  evaluateOpportunity,
  OPPORTUNITY_EVENTS,
  type OpportunityDecision,
  type OpportunityEvidence,
  type OpportunityEvent,
  type OpportunitySignal,
  type OpportunityStrategy,
  type TenantAutonomyPolicy,
} from "@/lib/opportunity-intelligence/domain";
import type { DeduplicatedCandidate } from "@/lib/opportunity-intelligence/sources";

const pipelineMetaSchema = z.object({
  trace_id: z.string().uuid(),
  schema_version: z.literal(1),
  organization_id: z.string().uuid(),
});

export type OpportunityPipelineAssessment = {
  opportunity_id: string;
  candidate: DeduplicatedCandidate;
  required_signal_keys: string[];
  signals: OpportunitySignal[];
  evidence: OpportunityEvidence[];
  strategy: OpportunityStrategy | null;
  tenant_policy: TenantAutonomyPolicy;
  linked_lead_id: string | null;
  existing_lead: "none" | "active" | "won" | "lost" | "unknown";
  suppressed: boolean;
};

type PipelineEventPayload = {
  trace_id: string;
  schema_version: 1;
  organization_id: string;
  opportunity_id: string;
  state: OpportunityDecision["state"];
  action: OpportunityDecision["action"];
  confidence: number;
  requires_human: boolean;
  exception_codes: string[];
  evidence_ids: string[];
  signal_keys?: string[];
};

export type OpportunityEventEnvelope = {
  event_type: OpportunityEvent;
  entity_kind: "opportunity";
  entity_id: string;
  payload: PipelineEventPayload;
  metadata: {
    idempotency_key: string;
    source_id: string;
    external_id: string;
    duplicate_source_ids: string[];
  };
};

export type OpportunityActionPlan = {
  action: OpportunityDecision["action"];
  status: "proposed";
  idempotency_key: string;
  requires_human_approval: boolean;
  pain_hypothesis: string | null;
  target_offer: string | null;
  proof_asset_summary: string | null;
  evidence_keys: string[];
  reason: string | null;
};

export type OpportunityPipelineItem = {
  opportunity_id: string;
  identity_key: string;
  decision: OpportunityDecision;
  action_plan: OpportunityActionPlan;
  events: OpportunityEventEnvelope[];
};

export type OpportunityPipelinePlan = {
  trace_id: string;
  schema_version: 1;
  organization_id: string;
  items: OpportunityPipelineItem[];
};

function eventForDecision(decision: OpportunityDecision): OpportunityEvent {
  return decision.state === "action_ready" ? OPPORTUNITY_EVENTS[1] : OPPORTUNITY_EVENTS[2];
}

function eventPayload(
  meta: z.infer<typeof pipelineMetaSchema>,
  assessment: OpportunityPipelineAssessment,
  decision: OpportunityDecision,
): PipelineEventPayload {
  return {
    trace_id: meta.trace_id,
    schema_version: meta.schema_version,
    organization_id: meta.organization_id,
    opportunity_id: assessment.opportunity_id,
    state: decision.state,
    action: decision.action,
    confidence: decision.confidence,
    requires_human: decision.requires_human,
    exception_codes: decision.exceptions.map((exception) => exception.code),
    evidence_ids: decision.fresh_evidence_ids,
  };
}

function actionPlan(
  assessment: OpportunityPipelineAssessment,
  decision: OpportunityDecision,
): OpportunityActionPlan {
  const baseKey = buildOpportunityIdempotencyKey({
    organization_id: decision.organization_id,
    source_id: assessment.candidate.source_id,
    external_id: assessment.candidate.external_id,
  });
  const recommended = decision.recommended_action;

  return {
    action: decision.action,
    status: "proposed",
    idempotency_key: `${baseKey}:${decision.action}`,
    requires_human_approval: decision.requires_human,
    pain_hypothesis: recommended?.pain_hypothesis ?? null,
    target_offer: recommended?.target_offer ?? null,
    proof_asset_summary: recommended?.proof_asset_summary ?? null,
    evidence_keys: recommended?.evidence_ids ?? decision.fresh_evidence_ids,
    reason: decision.exceptions.map((exception) => exception.message).join(" ") || null,
  };
}

/**
 * Converts an assessed discovery batch into persistence/event commands.
 *
 * This function has no Supabase, HTTP, WhatsApp or LLM side effect. The worker
 * can upsert the record/evidence/action rows and emit these envelopes in one
 * transaction, then let the existing event-log drain perform later work.
 */
export function planOpportunityPipeline(input: {
  trace_id: string;
  schema_version: 1;
  organization_id: string;
  assessments: OpportunityPipelineAssessment[];
  now?: Date;
}): OpportunityPipelinePlan {
  const meta = pipelineMetaSchema.parse(input);
  const now = input.now ?? new Date();

  const items = input.assessments.map((assessment) => {
    const expectedIdentityKey = canonicalIdentityKey(assessment.candidate.identity);
    if (expectedIdentityKey !== assessment.candidate.identity_key) {
      throw new Error("opportunity candidate identity_key does not match its identity");
    }

    const decision = evaluateOpportunity(
      {
        organization_id: meta.organization_id,
        linked_lead_id: assessment.linked_lead_id,
        required_signal_keys: assessment.required_signal_keys,
        signals: assessment.signals,
        evidence: assessment.evidence,
        strategy: assessment.strategy,
        tenant_policy: assessment.tenant_policy,
        existing_lead: assessment.existing_lead,
        suppressed: assessment.suppressed,
      },
      now,
    );
    const action = actionPlan(assessment, decision);
    const metadata = {
      idempotency_key: action.idempotency_key,
      source_id: assessment.candidate.source_id,
      external_id: assessment.candidate.external_id,
      duplicate_source_ids: assessment.candidate.duplicate_source_ids,
    };
    const basePayload = eventPayload(meta, assessment, decision);
    const events: OpportunityEventEnvelope[] = [
      {
        event_type: OPPORTUNITY_EVENTS[0],
        entity_kind: "opportunity",
        entity_id: assessment.opportunity_id,
        payload: { ...basePayload, signal_keys: assessment.signals.map((signal) => signal.key) },
        metadata,
      },
      {
        event_type: eventForDecision(decision),
        entity_kind: "opportunity",
        entity_id: assessment.opportunity_id,
        payload: basePayload,
        metadata,
      },
    ];

    return {
      opportunity_id: assessment.opportunity_id,
      identity_key: assessment.candidate.identity_key,
      decision,
      action_plan: action,
      events,
    };
  });

  return { ...meta, items };
}

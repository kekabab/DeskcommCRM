import { z } from "zod";

/**
 * Domínio puro do Radar de Oportunidades.
 *
 * Este módulo não conhece Supabase, WhatsApp ou um provedor de IA. Ele recebe
 * fatos verificados e devolve uma decisão determinística. Isso mantém a IA no
 * lugar certo: propor hipóteses, nunca fabricar lastro.
 */

export const OPPORTUNITY_STATES = [
  "discovered",
  "validating",
  "action_ready",
  "awaiting_human",
  "contacted",
  "engaged",
  "converted",
  "dismissed",
  "suppressed",
  "stale",
] as const;

export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export const OPPORTUNITY_ACTIONS = [
  "collect_more_evidence",
  "refresh_evidence",
  "prepare_personalized_draft",
  "request_human_review",
  "link_existing_lead",
  "suppress",
] as const;

export type OpportunityAction = (typeof OPPORTUNITY_ACTIONS)[number];

/** Event names accepted by the CRM event_log contract (exactly one dot). */
export const OPPORTUNITY_EVENTS = [
  "opportunity.signal_detected",
  "opportunity.ready_for_action",
  "opportunity.exception_raised",
  "opportunity.outcome_recorded",
] as const;

export type OpportunityEvent = (typeof OPPORTUNITY_EVENTS)[number];

const timestampSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "timestamp must be a valid ISO-8601 date");

export const evidenceSchema = z.object({
  evidence_id: z.string().trim().min(1).max(160),
  source_id: z.string().trim().min(1).max(120),
  source_kind: z.enum(["open_data", "official_api", "tenant_first_party", "operator_verified"]),
  source_url: z.string().url(),
  terms_url: z.string().url(),
  policy_status: z.enum(["verified_allowed", "operator_reviewed", "unknown"]),
  claim: z.string().trim().min(1).max(600),
  signal_keys: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
  polarity: z.enum(["supports", "contradicts"]),
  confidence: z.number().min(0).max(1),
  collected_at: timestampSchema,
  freshness_ttl_hours: z.number().int().min(1).max(8_760),
});

export type OpportunityEvidence = z.infer<typeof evidenceSchema>;

export const signalSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_.-]{1,99}$/),
  label: z.string().trim().min(1).max(160),
  evidence_ids: z.array(z.string().trim().min(1)).min(1).max(20),
  priority: z.enum(["low", "medium", "high"]),
});

export type OpportunitySignal = z.infer<typeof signalSchema>;

export const opportunityIdentitySchema = z.object({
  display_name: z.string().trim().min(1).max(240),
  domain: z.string().trim().min(1).max(240).optional(),
  registry_id: z.string().trim().min(1).max(120).optional(),
  phone_e164: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/)
    .optional(),
});

export type OpportunityIdentity = z.infer<typeof opportunityIdentitySchema>;

export const tenantAutonomyPolicySchema = z.object({
  require_human_approval: z.boolean(),
});

export type TenantAutonomyPolicy = z.infer<typeof tenantAutonomyPolicySchema>;

export const opportunityStrategySchema = z.object({
  pain_hypothesis: z.string().trim().min(1).max(500),
  target_offer: z.string().trim().min(1).max(240),
  proof_asset_summary: z.string().trim().min(1).max(800),
  evidence_ids: z.array(z.string().trim().min(1)).min(1).max(20),
});

export type OpportunityStrategy = z.infer<typeof opportunityStrategySchema>;

export const recommendedActionSchema = z.object({
  action: z.enum(OPPORTUNITY_ACTIONS),
  pain_hypothesis: z.string().trim().min(1).max(500).optional(),
  target_offer: z.string().trim().min(1).max(240).optional(),
  proof_asset_summary: z.string().trim().min(1).max(800).optional(),
  evidence_ids: z.array(z.string().trim().min(1)).max(20),
});

export type RecommendedAction = z.infer<typeof recommendedActionSchema>;

export const opportunityEvaluationInputSchema = z.object({
  organization_id: z.string().uuid(),
  linked_lead_id: z.string().uuid().nullable(),
  required_signal_keys: z.array(z.string().trim().min(1)).min(1).max(40),
  signals: z.array(signalSchema).min(1).max(40),
  evidence: z.array(evidenceSchema).max(200),
  strategy: opportunityStrategySchema.nullable(),
  tenant_policy: tenantAutonomyPolicySchema,
  existing_lead: z.enum(["none", "active", "won", "lost", "unknown"]),
  suppressed: z.boolean(),
});

export type OpportunityEvaluationInput = z.infer<typeof opportunityEvaluationInputSchema>;

export type OpportunityExceptionCode =
  | "no_evidence"
  | "stale_evidence"
  | "source_policy_unknown"
  | "contradictory_evidence"
  | "low_confidence"
  | "missing_value_hypothesis"
  | "unsupported_claim"
  | "tenant_requires_approval"
  | "existing_active_lead"
  | "suppressed_recipient"
  | "signal_without_evidence";

export type OpportunityException = {
  code: OpportunityExceptionCode;
  message: string;
  requires_human: boolean;
};

export type OpportunityDecision = {
  state: OpportunityState;
  action: OpportunityAction;
  requires_human: boolean;
  organization_id: string;
  linked_lead_id: string | null;
  confidence: number;
  fresh_evidence_ids: string[];
  stale_evidence_ids: string[];
  exceptions: OpportunityException[];
  recommended_action: RecommendedAction | null;
};

const AUTO_ACTION_CONFIDENCE = 0.75;
const HUMAN_REVIEW_CONFIDENCE = 0.55;

function clampConfidence(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

function evidenceIsFresh(evidence: OpportunityEvidence, now: Date): boolean {
  const collectedAt = new Date(evidence.collected_at).getTime();
  const expiresAt = collectedAt + evidence.freshness_ttl_hours * 60 * 60 * 1_000;
  return Number.isFinite(collectedAt) && expiresAt >= now.getTime();
}

function isAllowedSource(evidence: OpportunityEvidence): boolean {
  return (
    evidence.policy_status === "verified_allowed" ||
    (evidence.source_kind === "operator_verified" && evidence.policy_status === "operator_reviewed")
  );
}

export function canonicalIdentityKey(identity: OpportunityIdentity): string {
  const parsed = opportunityIdentitySchema.parse(identity);
  const domain = parsed.domain
    ?.trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const registryId = parsed.registry_id?.replace(/\D/g, "");
  const phone = parsed.phone_e164?.replace(/\D/g, "");

  // One identity must have one stable primary key. Adding optional fields to a
  // composite key would split the same company when a later source enriches a
  // domain-only record with a phone or registry id. Aliases can be introduced
  // later; this first cut keeps the strongest available identifier stable.
  if (registryId) return `registry:${registryId}`;
  if (domain) return `domain:${domain}`;
  if (phone) return `phone:${phone}`;
  return `name:${parsed.display_name.trim().toLowerCase().replace(/\s+/g, " ")}`;
}

export function buildOpportunityIdempotencyKey(input: {
  organization_id: string;
  source_id: string;
  external_id: string;
}): string {
  return [input.organization_id.trim(), input.source_id.trim(), input.external_id.trim()]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function unsupportedEvidenceIds(
  claims: Array<{ evidence_ids: string[] }>,
  evidence: OpportunityEvidence[],
  now = new Date(),
): string[] {
  const validEvidenceIds = new Set(
    evidence
      .filter((item) => evidenceIsFresh(item, now) && isAllowedSource(item))
      .map((item) => item.evidence_id),
  );

  return claims.flatMap((claim) => claim.evidence_ids.filter((id) => !validEvidenceIds.has(id)));
}

export function evaluateOpportunity(
  rawInput: OpportunityEvaluationInput,
  now = new Date(),
): OpportunityDecision {
  const input = opportunityEvaluationInputSchema.parse(rawInput);
  const exceptions: OpportunityException[] = [];
  const baseDecision = {
    organization_id: input.organization_id,
    linked_lead_id: input.linked_lead_id,
  };

  if (input.suppressed) {
    return {
      ...baseDecision,
      state: "suppressed",
      action: "suppress",
      requires_human: false,
      confidence: 1,
      fresh_evidence_ids: [],
      stale_evidence_ids: [],
      exceptions: [
        {
          code: "suppressed_recipient",
          message: "Recipient is on the tenant suppression list.",
          requires_human: false,
        },
      ],
      recommended_action: null,
    };
  }

  if (input.existing_lead === "active" || input.existing_lead === "unknown") {
    return {
      ...baseDecision,
      state: "awaiting_human",
      action: "link_existing_lead",
      requires_human: true,
      confidence: 0,
      fresh_evidence_ids: [],
      stale_evidence_ids: [],
      exceptions: [
        {
          code: "existing_active_lead",
          message:
            "An existing or ambiguous CRM lead must be linked before creating a new opportunity.",
          requires_human: true,
        },
      ],
      recommended_action: null,
    };
  }

  const suppliedEvidenceIds = new Set(input.evidence.map((item) => item.evidence_id));
  const unsupportedSignalEvidenceIds = [
    ...new Set(
      input.signals.flatMap((signal) =>
        signal.evidence_ids.filter((id) => !suppliedEvidenceIds.has(id)),
      ),
    ),
  ];
  if (unsupportedSignalEvidenceIds.length > 0) {
    return {
      ...baseDecision,
      state: "awaiting_human",
      action: "request_human_review",
      requires_human: true,
      confidence: 0,
      fresh_evidence_ids: [],
      stale_evidence_ids: [],
      exceptions: [
        {
          code: "signal_without_evidence",
          message: `Signal references evidence that was not supplied: ${unsupportedSignalEvidenceIds.join(", ")}.`,
          requires_human: true,
        },
      ],
      recommended_action: null,
    };
  }

  if (input.evidence.length === 0) {
    return {
      ...baseDecision,
      state: "validating",
      action: "collect_more_evidence",
      requires_human: false,
      confidence: 0,
      fresh_evidence_ids: [],
      stale_evidence_ids: [],
      exceptions: [
        {
          code: "no_evidence",
          message: "No evidence supports this opportunity yet.",
          requires_human: false,
        },
      ],
      recommended_action: null,
    };
  }

  const freshEvidence = input.evidence.filter((item) => evidenceIsFresh(item, now));
  const staleEvidence = input.evidence.filter((item) => !evidenceIsFresh(item, now));
  const unknownSources = freshEvidence.filter((item) => !isAllowedSource(item));
  const allowedFreshEvidence = freshEvidence.filter(isAllowedSource);
  const supportBySignal = new Map<string, { supports: number; contradicts: number }>();

  for (const item of allowedFreshEvidence) {
    for (const signalKey of item.signal_keys) {
      const counts = supportBySignal.get(signalKey) ?? { supports: 0, contradicts: 0 };
      counts[item.polarity] += 1;
      supportBySignal.set(signalKey, counts);
    }
  }

  const contradictorySignals = [...supportBySignal.entries()]
    .filter(([, counts]) => counts.supports > 0 && counts.contradicts > 0)
    .map(([key]) => key);

  if (unknownSources.length > 0) {
    exceptions.push({
      code: "source_policy_unknown",
      message: "One or more fresh sources are not allowed by the source policy.",
      requires_human: true,
    });
  }
  if (contradictorySignals.length > 0) {
    exceptions.push({
      code: "contradictory_evidence",
      message: `Evidence disagrees for: ${contradictorySignals.join(", ")}.`,
      requires_human: true,
    });
  }

  const supportedRequiredSignals = input.required_signal_keys.filter((key) =>
    allowedFreshEvidence.some(
      (item) => item.polarity === "supports" && item.signal_keys.includes(key),
    ),
  );
  const coverage = supportedRequiredSignals.length / input.required_signal_keys.length;
  const averageEvidenceConfidence = allowedFreshEvidence.length
    ? allowedFreshEvidence.reduce((sum, item) => sum + item.confidence, 0) /
      allowedFreshEvidence.length
    : 0;
  const freshness = input.evidence.length ? freshEvidence.length / input.evidence.length : 0;
  const confidence = clampConfidence(
    averageEvidenceConfidence * 0.7 + coverage * 0.2 + freshness * 0.1,
  );

  if (allowedFreshEvidence.length === 0) {
    exceptions.push({
      code: "stale_evidence",
      message: "All available evidence is stale or disallowed.",
      requires_human: false,
    });
    return {
      ...baseDecision,
      state: "stale",
      action: "refresh_evidence",
      requires_human: false,
      confidence,
      fresh_evidence_ids: [],
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: null,
    };
  }

  if (exceptions.some((item) => item.requires_human)) {
    return {
      ...baseDecision,
      state: "awaiting_human",
      action: "request_human_review",
      requires_human: true,
      confidence,
      fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: null,
    };
  }

  if (confidence < HUMAN_REVIEW_CONFIDENCE) {
    exceptions.push({
      code: "low_confidence",
      message: "Evidence is too weak to justify an action.",
      requires_human: true,
    });
    return {
      ...baseDecision,
      state: "awaiting_human",
      action: "request_human_review",
      requires_human: true,
      confidence,
      fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: null,
    };
  }

  if (confidence < AUTO_ACTION_CONFIDENCE || coverage < 1) {
    exceptions.push({
      code: "low_confidence",
      message: "More evidence is needed before preparing an autonomous action.",
      requires_human: false,
    });
    return {
      ...baseDecision,
      state: "validating",
      action: "collect_more_evidence",
      requires_human: false,
      confidence,
      fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: null,
    };
  }

  if (!input.strategy) {
    exceptions.push({
      code: "missing_value_hypothesis",
      message: "A high-confidence signal set still needs a pain, offer and proof hypothesis.",
      requires_human: false,
    });
    return {
      ...baseDecision,
      state: "validating",
      action: "collect_more_evidence",
      requires_human: false,
      confidence,
      fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: null,
    };
  }

  const unsupportedStrategyEvidence = unsupportedEvidenceIds([input.strategy], input.evidence, now);
  if (unsupportedStrategyEvidence.length > 0) {
    exceptions.push({
      code: "unsupported_claim",
      message: "The proposed pain, offer or proof contains claims without fresh evidence.",
      requires_human: true,
    });
    return {
      ...baseDecision,
      state: "awaiting_human",
      action: "request_human_review",
      requires_human: true,
      confidence,
      fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: null,
    };
  }

  const recommendedAction: RecommendedAction = {
    action: "prepare_personalized_draft",
    pain_hypothesis: input.strategy.pain_hypothesis,
    target_offer: input.strategy.target_offer,
    proof_asset_summary: input.strategy.proof_asset_summary,
    evidence_ids: input.strategy.evidence_ids,
  };

  if (input.tenant_policy.require_human_approval) {
    exceptions.push({
      code: "tenant_requires_approval",
      message:
        "This organization requires human approval before an action is prepared for execution.",
      requires_human: true,
    });
    return {
      ...baseDecision,
      state: "awaiting_human",
      action: "request_human_review",
      requires_human: true,
      confidence,
      fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
      stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
      exceptions,
      recommended_action: recommendedAction,
    };
  }

  return {
    ...baseDecision,
    state: "action_ready",
    action: "prepare_personalized_draft",
    requires_human: false,
    confidence,
    fresh_evidence_ids: allowedFreshEvidence.map((item) => item.evidence_id),
    stale_evidence_ids: staleEvidence.map((item) => item.evidence_id),
    exceptions,
    recommended_action: recommendedAction,
  };
}

export const OPPORTUNITY_OUTCOME_KINDS = [
  "reply",
  "meeting",
  "deal_won",
  "deal_lost",
  "unsubscribed",
  "ignored",
] as const;

export type OpportunityOutcomeKind = (typeof OPPORTUNITY_OUTCOME_KINDS)[number];

export const opportunityOutcomeSchema = z.object({
  outcome_id: z.string().uuid(),
  organization_id: z.string().uuid(),
  opportunity_id: z.string().uuid(),
  action_id: z.string().uuid().nullable(),
  kind: z.enum(OPPORTUNITY_OUTCOME_KINDS),
  reason: z.string().trim().max(500).nullable(),
  occurred_at: timestampSchema,
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type OpportunityOutcome = z.infer<typeof opportunityOutcomeSchema>;

export function applyOutcome(
  state: OpportunityState,
  outcomeInput: OpportunityOutcome,
): OpportunityState {
  const outcome = opportunityOutcomeSchema.parse(outcomeInput);
  if (state === "suppressed") return state;

  switch (outcome.kind) {
    case "deal_won":
      return "converted";
    case "unsubscribed":
      return "suppressed";
    case "deal_lost":
    case "ignored":
      return "dismissed";
    case "reply":
    case "meeting":
      return "engaged";
  }
}

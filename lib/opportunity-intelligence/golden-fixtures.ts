import type { OpportunityEvaluationInput } from "@/lib/opportunity-intelligence/domain";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_LEAD_ID = "00000000-0000-4000-8000-000000000010";

function evidence(input: {
  evidence_id: string;
  signal_keys: string[];
  confidence: number;
  polarity?: "supports" | "contradicts";
  collected_at?: string;
}) {
  return {
    evidence_id: input.evidence_id,
    source_id: "synthetic-public-source",
    source_kind: "open_data" as const,
    source_url: `https://synthetic.example/evidence/${input.evidence_id}`,
    terms_url: "https://synthetic.example/terms",
    policy_status: "verified_allowed" as const,
    claim: `Synthetic fact for ${input.evidence_id}`,
    signal_keys: input.signal_keys,
    polarity: input.polarity ?? ("supports" as const),
    confidence: input.confidence,
    collected_at: input.collected_at ?? "2026-09-20T15:00:00.000Z",
    freshness_ttl_hours: 72,
  };
}

const signals = [
  {
    key: "missing_conversion_path",
    label: "No clear conversion path",
    evidence_ids: ["site-gap"],
    priority: "high" as const,
  },
  {
    key: "active_demand",
    label: "Recent public demand",
    evidence_ids: ["demand"],
    priority: "high" as const,
  },
];

const strategy = {
  pain_hypothesis: "Demand is being lost between discovery and contact.",
  target_offer: "A conversion-first landing page with assisted handoff.",
  proof_asset_summary: "A one-page diagnostic with the evidence and proposed flow.",
  evidence_ids: ["site-gap", "demand"],
};

export type GoldenOpportunityFixture = {
  case_id: string;
  description: string;
  expected: { state: string; action: string; requires_human: boolean };
  input: OpportunityEvaluationInput;
};

export const GOLDEN_OPPORTUNITY_FIXTURES: GoldenOpportunityFixture[] = [
  {
    case_id: "MOCK-CORP-01",
    description: "Strong evidence produces a personalized draft, never an automatic send.",
    expected: {
      state: "action_ready",
      action: "prepare_personalized_draft",
      requires_human: false,
    },
    input: {
      organization_id: ORGANIZATION_ID,
      linked_lead_id: null,
      required_signal_keys: ["missing_conversion_path", "active_demand"],
      signals,
      evidence: [
        evidence({
          evidence_id: "site-gap",
          signal_keys: ["missing_conversion_path"],
          confidence: 0.96,
        }),
        evidence({ evidence_id: "demand", signal_keys: ["active_demand"], confidence: 0.93 }),
      ],
      strategy,
      tenant_policy: { require_human_approval: false },
      existing_lead: "none",
      suppressed: false,
    },
  },
  {
    case_id: "MOCK-CORP-02",
    description: "Contradictory facts always reach the exception queue.",
    expected: { state: "awaiting_human", action: "request_human_review", requires_human: true },
    input: {
      organization_id: ORGANIZATION_ID,
      linked_lead_id: null,
      required_signal_keys: ["missing_conversion_path", "active_demand"],
      signals,
      evidence: [
        evidence({
          evidence_id: "site-gap",
          signal_keys: ["missing_conversion_path"],
          confidence: 0.96,
        }),
        evidence({
          evidence_id: "site-present",
          signal_keys: ["missing_conversion_path"],
          confidence: 0.92,
          polarity: "contradicts",
        }),
        evidence({ evidence_id: "demand", signal_keys: ["active_demand"], confidence: 0.93 }),
      ],
      strategy,
      tenant_policy: { require_human_approval: false },
      existing_lead: "none",
      suppressed: false,
    },
  },
  {
    case_id: "MOCK-CORP-03",
    description: "An active CRM lead is linked instead of duplicated.",
    expected: { state: "awaiting_human", action: "link_existing_lead", requires_human: true },
    input: {
      organization_id: ORGANIZATION_ID,
      linked_lead_id: OTHER_LEAD_ID,
      required_signal_keys: ["missing_conversion_path", "active_demand"],
      signals,
      evidence: [],
      strategy: null,
      tenant_policy: { require_human_approval: false },
      existing_lead: "active",
      suppressed: false,
    },
  },
  {
    case_id: "MOCK-CORP-04",
    description: "Suppression blocks the entire action path before scoring.",
    expected: { state: "suppressed", action: "suppress", requires_human: false },
    input: {
      organization_id: ORGANIZATION_ID,
      linked_lead_id: null,
      required_signal_keys: ["missing_conversion_path", "active_demand"],
      signals,
      evidence: [],
      strategy: null,
      tenant_policy: { require_human_approval: false },
      existing_lead: "none",
      suppressed: true,
    },
  },
  {
    case_id: "MOCK-CORP-05",
    description: "Weak evidence is not discarded silently; it escalates for review.",
    expected: { state: "awaiting_human", action: "request_human_review", requires_human: true },
    input: {
      organization_id: ORGANIZATION_ID,
      linked_lead_id: null,
      required_signal_keys: ["missing_conversion_path", "active_demand"],
      signals,
      evidence: [
        evidence({
          evidence_id: "weak",
          signal_keys: ["missing_conversion_path"],
          confidence: 0.4,
        }),
      ],
      strategy: null,
      tenant_policy: { require_human_approval: false },
      existing_lead: "none",
      suppressed: false,
    },
  },
];

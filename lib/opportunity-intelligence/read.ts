import type { SupabaseClient } from "@supabase/supabase-js";

import type { OpportunityAction, OpportunityState } from "@/lib/opportunity-intelligence/domain";

export type OpportunityRecordRow = {
  id: string;
  organization_id: string;
  linked_lead_id: string | null;
  identity_key: string;
  display_name: string;
  domain: string | null;
  region_key: string | null;
  state: OpportunityState;
  confidence: number;
  signals: Array<{ key?: string; label?: string; evidence_ids?: string[]; priority?: string }>;
  exception_code: string | null;
  exception_message: string | null;
  last_evaluated_at: string | null;
  last_exception_at: string | null;
  suppressed_at: string | null;
  suppressed_reason: string | null;
  created_at: string;
  updated_at: string;
};

export type OpportunityEvidenceRow = {
  id: string;
  opportunity_id: string;
  evidence_key: string;
  source_id: string;
  source_url: string;
  terms_url: string;
  policy_status: string;
  claim: string;
  confidence: number;
  collected_at: string;
  expires_at: string;
};

export type OpportunityActionRow = {
  id: string;
  opportunity_id: string;
  action: OpportunityAction;
  status: "proposed" | "approved" | "executed" | "blocked" | "rejected";
  requires_human_approval: boolean;
  pain_hypothesis: string | null;
  target_offer: string | null;
  proof_asset_summary: string | null;
  evidence_keys: string[];
  reason: string | null;
  created_at: string;
};

export type OpportunityRadarRow = OpportunityRecordRow & {
  latest_action: OpportunityActionRow | null;
  evidence: OpportunityEvidenceRow[];
};

const RECORD_COLUMNS =
  "id, organization_id, linked_lead_id, identity_key, display_name, domain, region_key, state, confidence, signals, exception_code, exception_message, last_evaluated_at, last_exception_at, suppressed_at, suppressed_reason, created_at, updated_at";
const EVIDENCE_COLUMNS =
  "id, opportunity_id, evidence_key, source_id, source_url, terms_url, policy_status, claim, confidence, collected_at, expires_at";
const ACTION_COLUMNS =
  "id, opportunity_id, action, status, requires_human_approval, pain_hypothesis, target_offer, proof_asset_summary, evidence_keys, reason, created_at";

const RADAR_STATE_ORDER: Record<OpportunityState, number> = {
  awaiting_human: 0,
  action_ready: 1,
  validating: 2,
  stale: 3,
  discovered: 4,
  contacted: 5,
  engaged: 6,
  converted: 7,
  dismissed: 8,
  suppressed: 9,
};

/** Read-only tenant-scoped projection for Radar, Dossiê and the exception queue. */
export async function loadOpportunityRadar(
  client: SupabaseClient,
  organizationId: string,
  limit = 100,
): Promise<OpportunityRadarRow[]> {
  const { data, error } = await client
    .from("opportunity_records")
    .select(RECORD_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`opportunity_records_read_failed: ${error.message}`);

  const records = (data ?? []) as unknown as OpportunityRecordRow[];
  const opportunityIds = records.map((record) => record.id);
  if (opportunityIds.length === 0) return [];

  const [evidenceResult, actionResult] = await Promise.all([
    client
      .from("opportunity_evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("organization_id", organizationId)
      .in("opportunity_id", opportunityIds)
      .order("collected_at", { ascending: false }),
    client
      .from("opportunity_actions")
      .select(ACTION_COLUMNS)
      .eq("organization_id", organizationId)
      .in("opportunity_id", opportunityIds)
      .order("created_at", { ascending: false }),
  ]);

  if (evidenceResult.error)
    throw new Error(`opportunity_evidence_read_failed: ${evidenceResult.error.message}`);
  if (actionResult.error)
    throw new Error(`opportunity_actions_read_failed: ${actionResult.error.message}`);

  const evidenceByOpportunity = new Map<string, OpportunityEvidenceRow[]>();
  for (const evidence of (evidenceResult.data ?? []) as unknown as OpportunityEvidenceRow[]) {
    const current = evidenceByOpportunity.get(evidence.opportunity_id) ?? [];
    current.push(evidence);
    evidenceByOpportunity.set(evidence.opportunity_id, current);
  }

  const latestActionByOpportunity = new Map<string, OpportunityActionRow>();
  for (const action of (actionResult.data ?? []) as unknown as OpportunityActionRow[]) {
    if (!latestActionByOpportunity.has(action.opportunity_id)) {
      latestActionByOpportunity.set(action.opportunity_id, action);
    }
  }

  return records
    .map((record) => ({
      ...record,
      latest_action: latestActionByOpportunity.get(record.id) ?? null,
      evidence: evidenceByOpportunity.get(record.id) ?? [],
    }))
    .sort((a, b) => {
      const stateDelta = RADAR_STATE_ORDER[a.state] - RADAR_STATE_ORDER[b.state];
      if (stateDelta !== 0) return stateDelta;
      return b.confidence - a.confidence;
    });
}

export type OpportunityOutcomeRow = {
  id: string;
  opportunity_id: string;
  action_id: string | null;
  idempotency_key: string;
  kind: string;
  reason: string | null;
  occurred_at: string;
  metrics: Record<string, unknown>;
  created_at: string;
};

export type OpportunityFactBreakdown = {
  facts: Array<{
    claim: string;
    confidence: number;
  }>;
  anchors: Array<{
    source_id: string;
    source_url: string;
    terms_url: string;
    collected_at: string;
    expires_at: string;
    is_expired: boolean;
    policy_status: string;
  }>;
  consequence: {
    pain_hypothesis: string | null;
    inaction_risk: string | null;
  };
  tangible_proof: {
    target_offer: string | null;
    proof_asset_summary: string | null;
  };
};

export type OpportunityDossier = {
  record: OpportunityRecordRow;
  evidence: OpportunityEvidenceRow[];
  actions: OpportunityActionRow[];
  outcomes: OpportunityOutcomeRow[];
  fact: OpportunityFactBreakdown;
  active_action: OpportunityActionRow | null;
};

const OUTCOME_COLUMNS =
  "id, opportunity_id, action_id, idempotency_key, kind, reason, occurred_at, metrics, created_at";

/**
 * Tenant-scoped detailed dossier projection implementing the FACT standard:
 * - Fato (sinais e alegações verificadas)
 * - Âncora & Frescor (fonte, URL, validade/TTL e licença)
 * - Consequência (dor do cliente e risco de inação)
 * - Prova Tangível (oferta e mini ativo de diagnóstico)
 */
export async function loadOpportunityDossier(
  client: SupabaseClient,
  organizationId: string,
  opportunityId: string,
  nowIso = new Date().toISOString(),
): Promise<OpportunityDossier | null> {
  const { data: recordData, error: recordError } = await client
    .from("opportunity_records")
    .select(RECORD_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", opportunityId)
    .maybeSingle();

  if (recordError) {
    throw new Error(`opportunity_record_read_failed: ${recordError.message}`);
  }
  if (!recordData) return null;

  const record = recordData as unknown as OpportunityRecordRow;

  const [evidenceResult, actionsResult, outcomesResult] = await Promise.all([
    client
      .from("opportunity_evidence")
      .select(EVIDENCE_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("opportunity_id", opportunityId)
      .order("collected_at", { ascending: false }),
    client
      .from("opportunity_actions")
      .select(ACTION_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("opportunity_id", opportunityId)
      .order("created_at", { ascending: false }),
    client
      .from("opportunity_outcomes")
      .select(OUTCOME_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("opportunity_id", opportunityId)
      .order("occurred_at", { ascending: false }),
  ]);

  if (evidenceResult.error)
    throw new Error(`opportunity_evidence_read_failed: ${evidenceResult.error.message}`);
  if (actionsResult.error)
    throw new Error(`opportunity_actions_read_failed: ${actionsResult.error.message}`);
  if (outcomesResult.error)
    throw new Error(`opportunity_outcomes_read_failed: ${outcomesResult.error.message}`);

  const evidence = (evidenceResult.data ?? []) as unknown as OpportunityEvidenceRow[];
  const actions = (actionsResult.data ?? []) as unknown as OpportunityActionRow[];
  const outcomes = (outcomesResult.data ?? []) as unknown as OpportunityOutcomeRow[];

  const activeAction =
    actions.find((a) => a.status === "proposed" || a.status === "approved") ?? actions[0] ?? null;

  const fact: OpportunityFactBreakdown = {
    facts: evidence.map((ev) => ({
      claim: ev.claim,
      confidence: ev.confidence,
    })),
    anchors: evidence.map((ev) => ({
      source_id: ev.source_id,
      source_url: ev.source_url,
      terms_url: ev.terms_url,
      collected_at: ev.collected_at,
      expires_at: ev.expires_at,
      is_expired: ev.expires_at <= nowIso,
      policy_status: ev.policy_status,
    })),
    consequence: {
      pain_hypothesis: activeAction?.pain_hypothesis ?? null,
      inaction_risk: record.exception_message ?? activeAction?.reason ?? null,
    },
    tangible_proof: {
      target_offer: activeAction?.target_offer ?? null,
      proof_asset_summary: activeAction?.proof_asset_summary ?? null,
    },
  };

  return {
    record,
    evidence,
    actions,
    outcomes,
    fact,
    active_action: activeAction,
  };
}

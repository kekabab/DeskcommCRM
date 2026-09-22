/**
 * Runner operacional do primeiro adapter de presença web.
 *
 * A coleta é injetável: o adapter declara fonte, termos, regiões e rate limit;
 * o worker só transforma fatos em uma proposta Copiloto e persiste pelo writer
 * canônico. Nenhum caminho deste arquivo envia outbound.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  OpportunityEvidence,
  OpportunitySignal,
  OpportunityStrategy,
} from "@/lib/opportunity-intelligence/domain";
import type { OpportunityPipelineAssessment } from "@/lib/opportunity-intelligence/pipeline";
import { runOpportunityDiscovery as runDiscoveryTick } from "@/lib/opportunity-intelligence/worker";
import {
  createWebPresenceAdapter,
  WEB_PRESENCE_SOURCE_MANIFEST,
  type WebPresenceDataFetcher,
} from "@/lib/opportunity-intelligence/adapters/web-presence";
import {
  calculateTokenBucketConsumption,
  DEFAULT_TENANT_SOURCE_QUOTA,
  type QuotaCheckResult,
  type TokenBucketConfig,
  type TokenBucketState,
} from "@/lib/opportunity-intelligence/limits";
import type {
  DeduplicatedCandidate,
  DiscoveryQuery,
  SourceAdapter,
} from "@/lib/opportunity-intelligence/sources";
import { persistOpportunityPipelinePlan } from "@/lib/opportunity-intelligence/write";

export type OpportunityDiscoveryOptions = {
  client: SupabaseClient;
  organization_id: string;
  region: string;
  niche?: string;
  offer_key?: string;
  adapters?: SourceAdapter[];
  dataFetcher?: WebPresenceDataFetcher;
  /** Compatibilidade de chamada; a fronteira do worker força Copiloto. */
  tenant_policy?: { require_human_approval: boolean };
  actor_user_id?: string | null;
  /**
   * Contrato de quota determinística:
   * - preauthorized: o chamador já consumiu/validou a quota antes de entrar; não re-consome.
   * - state/config/cost: valida e consome dentro do próprio worker antes do fetch.
   */
  quota?:
    | { preauthorized: QuotaCheckResult }
    | {
        state: TokenBucketState;
        config?: TokenBucketConfig;
        cost?: number;
      };
  quotaState?: TokenBucketState;
  quotaConfig?: TokenBucketConfig;
  quotaCost?: number;
};

export type OpportunityDiscoveryWorkerResult = {
  trace_id: string;
  organization_id: string;
  attempted_source_ids: string[];
  blocked_source_ids: string[];
  candidates_discovered: number;
  opportunities_processed: number;
  actions_proposed: number;
  errors: Array<{ source_id?: string; code: string; message: string }>;
  quota?: QuotaCheckResult;
};

function buildAssessment(
  options: OpportunityDiscoveryOptions,
  query: DiscoveryQuery,
  adapters: SourceAdapter[],
  candidate: DeduplicatedCandidate,
): Promise<OpportunityPipelineAssessment | null> {
  return (async () => {
    let existingLead: "none" | "active" | "won" | "lost" | "unknown" = "none";
    let linkedLeadId: string | null = null;

    if (candidate.identity.domain) {
      const { data: leadMatch } = await options.client
        .from("crm_leads")
        .select("id, status")
        .eq("organization_id", query.organization_id)
        .ilike("email", `%@${candidate.identity.domain}`)
        .maybeSingle();

      if (leadMatch) {
        linkedLeadId = leadMatch.id;
        existingLead =
          leadMatch.status === "won" ? "won" : leadMatch.status === "lost" ? "lost" : "active";
      }
    }

    let contactSuppressed = false;
    if (candidate.identity.phone_e164) {
      const { data: contactMatch } = await options.client
        .from("contacts")
        .select("id, is_blocked, is_anonymized")
        .eq("organization_id", query.organization_id)
        .eq("phone_number", candidate.identity.phone_e164)
        .maybeSingle();

      if (
        contactMatch &&
        (Boolean(contactMatch.is_blocked) || Boolean(contactMatch.is_anonymized))
      ) {
        contactSuppressed = true;
      }
    }

    const { data: existingRecord } = await options.client
      .from("opportunity_records")
      .select("id, state")
      .eq("organization_id", query.organization_id)
      .eq("identity_key", candidate.identity_key)
      .maybeSingle();

    const isSuppressed = existingRecord?.state === "suppressed" || contactSuppressed;

    const manifest =
      adapters.find((adapter) => adapter.manifest.source_id === candidate.source_id)?.manifest ??
      WEB_PRESENCE_SOURCE_MANIFEST;
    const evidence: OpportunityEvidence[] = Object.entries(candidate.facts).map(([key, value]) => ({
      evidence_id: `ev-${candidate.external_id}-${key}`,
      source_id: candidate.source_id,
      source_kind: manifest.source_kind,
      source_url: candidate.source_url,
      terms_url: manifest.terms_url,
      policy_status: "verified_allowed",
      claim: `${key}: ${value}`,
      signal_keys: ["missing_conversion_path"],
      polarity: "supports",
      confidence: 0.9,
      collected_at: candidate.collected_at,
      freshness_ttl_hours: 168,
    }));

    // Sem evidência não existe hipótese segura para persistir (exceto suprimido terminal)
    if (evidence.length === 0) {
      if (!isSuppressed) return null;
      evidence.push({
        evidence_id: `ev-${candidate.external_id}-suppressed`,
        source_id: candidate.source_id,
        source_kind: manifest.source_kind,
        source_url: candidate.source_url,
        terms_url: manifest.terms_url,
        policy_status: "verified_allowed",
        claim: "recipient_suppressed: true",
        signal_keys: ["missing_conversion_path"],
        polarity: "supports",
        confidence: 1.0,
        collected_at: candidate.collected_at,
        freshness_ttl_hours: 168,
      });
    }

    const signals: OpportunitySignal[] = [
      {
        key: "missing_conversion_path",
        label: "Canal de conversão ausente ou deficiente",
        evidence_ids: evidence.map((item) => item.evidence_id),
        priority: "high",
      },
    ];
    const strategy: OpportunityStrategy = {
      pain_hypothesis:
        "Perda de clientes potenciais que buscam o negócio no celular e não encontram canal direto de contato.",
      target_offer: "Implantação de canal de captura e atendimento instantâneo.",
      proof_asset_summary: "Diagnóstico comparativo de presença local com checklist de conversão.",
      evidence_ids: evidence.map((item) => item.evidence_id),
    };

    return {
      candidate,
      opportunity_id: existingRecord?.id ?? randomUUID(),
      required_signal_keys: ["missing_conversion_path"],
      signals,
      evidence,
      strategy,
      tenant_policy: { require_human_approval: true },
      linked_lead_id: linkedLeadId,
      existing_lead: existingLead,
      suppressed: isSuppressed,
    };
  })();
}

export async function runOpportunityDiscovery(
  options: OpportunityDiscoveryOptions,
): Promise<OpportunityDiscoveryWorkerResult> {
  const traceId = randomUUID();
  const adapters = options.adapters ?? [createWebPresenceAdapter(options.dataFetcher)];

  // Validação determinística de quota antes do fetch (ponto único ou pré-autorizado)
  let quotaDecision: QuotaCheckResult | undefined;

  if (options.quota && "preauthorized" in options.quota) {
    // Quota pré-autorizada pelo chamador (ex: cron sweep): respeita sem re-consumir
    quotaDecision = options.quota.preauthorized;
    if (!quotaDecision.allowed) {
      const blockedSourceId = adapters[0]?.manifest.source_id ?? "unknown";
      return {
        trace_id: traceId,
        organization_id: options.organization_id,
        attempted_source_ids: [],
        blocked_source_ids: [blockedSourceId],
        candidates_discovered: 0,
        opportunities_processed: 0,
        actions_proposed: 0,
        errors: [
          {
            source_id: blockedSourceId,
            code: "quota_exceeded",
            message: `Tenant quota exceeded for source '${blockedSourceId}'. Retry after ${quotaDecision.retryAfterSeconds}s (tokens remaining: ${quotaDecision.remainingTokens}).`,
          },
        ],
        quota: quotaDecision,
      };
    }
  } else if (options.quotaState || (options.quota && "state" in options.quota)) {
    // Validação direta no worker quando chamado autonomamente
    const state =
      options.quota && "state" in options.quota ? options.quota.state : options.quotaState!;
    const config =
      (options.quota && "config" in options.quota ? options.quota.config : options.quotaConfig) ??
      DEFAULT_TENANT_SOURCE_QUOTA;
    const cost =
      (options.quota && "cost" in options.quota ? options.quota.cost : options.quotaCost) ?? 1;

    quotaDecision = calculateTokenBucketConsumption(state, cost, config);
    if (!quotaDecision.allowed) {
      const blockedSourceId = adapters[0]?.manifest.source_id ?? "unknown";
      return {
        trace_id: traceId,
        organization_id: options.organization_id,
        attempted_source_ids: [],
        blocked_source_ids: [blockedSourceId],
        candidates_discovered: 0,
        opportunities_processed: 0,
        actions_proposed: 0,
        errors: [
          {
            source_id: blockedSourceId,
            code: "quota_exceeded",
            message: `Tenant quota exceeded for source '${blockedSourceId}'. Retry after ${quotaDecision.retryAfterSeconds}s (tokens remaining: ${quotaDecision.remainingTokens}).`,
          },
        ],
        quota: quotaDecision,
      };
    }
  }

  const query: DiscoveryQuery = {
    organization_id: options.organization_id,
    region: options.region,
    niche: options.niche ?? "servicos_digitais",
    offer_key: options.offer_key ?? "otimizacao_conversao_local",
  };

  const tick = await runDiscoveryTick({
    query,
    adapters,
    trace_id: traceId,
    assessCandidate: async ({ candidate }) => buildAssessment(options, query, adapters, candidate),
    persistPlan: (plan, assessments) =>
      persistOpportunityPipelinePlan(options.client, plan, assessments, {
        actor_user_id: options.actor_user_id,
      }),
  });

  return {
    trace_id: tick.trace_id,
    organization_id: options.organization_id,
    attempted_source_ids: tick.discovery.attempted_source_ids,
    blocked_source_ids: tick.discovery.blocked_source_ids,
    candidates_discovered: tick.candidates_seen,
    opportunities_processed: tick.persisted?.persisted_count ?? 0,
    actions_proposed:
      tick.persisted?.results.filter((result) => result.action_id !== null).length ?? 0,
    errors: [
      ...tick.discovery.errors,
      ...tick.assessment_errors.map((error) => ({
        source_id: error.source_id,
        code: "candidate_assessment_failed",
        message: error.message,
      })),
    ],
    quota: quotaDecision,
  };
}

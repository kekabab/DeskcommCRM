import { describe, expect, it, vi } from "vitest";

import { runOpportunityDiscovery } from "@/lib/opportunity-intelligence/worker";
import type { OpportunityPipelineAssessment } from "@/lib/opportunity-intelligence/pipeline";
import type { SourceAdapter, SourceCandidate } from "@/lib/opportunity-intelligence/sources";

const organizationId = "00000000-0000-4000-8000-000000000001";
const query = {
  organization_id: organizationId,
  region: "br-sudeste",
  niche: "clinicas",
  offer_key: "conversion-first-site",
};
const manifest = {
  source_id: "open-places",
  source_kind: "open_data" as const,
  terms_url: "https://example.com/terms",
  allow_automated_collection: true,
  rate_limit_per_minute: 30,
  supports_regions: ["br-sudeste"],
};

function candidate(externalId: string, displayName = "Clínica Aurora"): SourceCandidate {
  return {
    source_id: manifest.source_id,
    external_id: externalId,
    identity: { display_name: displayName, domain: `https://${externalId}.example.com` },
    collected_at: "2026-09-20T15:00:00.000Z",
    source_url: `https://example.com/places/${externalId}`,
    facts: { category: "clinic" },
  };
}

function assessment(
  inputCandidate: OpportunityPipelineAssessment["candidate"],
): OpportunityPipelineAssessment {
  return {
    opportunity_id: "00000000-0000-4000-8000-000000000099",
    candidate: inputCandidate,
    required_signal_keys: ["active_demand"],
    signals: [
      {
        key: "active_demand",
        label: "Demanda pública recente",
        evidence_ids: ["demand"],
        priority: "high",
      },
    ],
    evidence: [
      {
        evidence_id: "demand",
        source_id: manifest.source_id,
        source_kind: manifest.source_kind,
        source_url: inputCandidate.source_url,
        terms_url: manifest.terms_url,
        policy_status: "verified_allowed",
        claim: "A empresa publicou uma demanda recente.",
        signal_keys: ["active_demand"],
        polarity: "supports",
        confidence: 0.95,
        collected_at: inputCandidate.collected_at,
        freshness_ttl_hours: 72,
      },
    ],
    strategy: {
      pain_hypothesis: "A demanda pode estar perdendo conversões.",
      target_offer: "Diagnóstico de conversão",
      proof_asset_summary: "Mini diagnóstico ancorado na fonte.",
      evidence_ids: ["demand"],
    },
    tenant_policy: { require_human_approval: false },
    linked_lead_id: null,
    existing_lead: "none",
    suppressed: false,
  };
}

describe("Opportunity Intelligence worker orchestration", () => {
  it("isolates assessment failures and always forces Copilot mode", async () => {
    const first = candidate("first", "Primeira clínica");
    const second = candidate("second", "Segunda clínica");
    const adapter: SourceAdapter = {
      manifest,
      discover: async () => [first, second],
    };
    const persistPlan = vi.fn(async (plan) => ({
      trace_id: plan.trace_id,
      organization_id: plan.organization_id,
      persisted_count: plan.items.length,
      results: [],
    }));

    const result = await runOpportunityDiscovery({
      query,
      adapters: [adapter],
      assessCandidate: async ({ candidate: discovered }) => {
        if (discovered.external_id === "first") throw new Error("assessment provider timeout");
        return assessment(discovered);
      },
      persistPlan,
      trace_id: "00000000-0000-4000-8000-000000000088",
    });

    expect(result.candidates_seen).toBe(2);
    expect(result.assessments_created).toBe(1);
    expect(result.assessment_errors).toEqual([
      expect.objectContaining({ external_id: "first", message: "assessment provider timeout" }),
    ]);
    expect(result.plan?.items).toHaveLength(1);
    expect(result.plan?.items[0]?.decision.requires_human).toBe(true);
    expect(persistPlan).toHaveBeenCalledOnce();
  });

  it("does not call persistence when discovery produces no assessable candidate", async () => {
    const persistPlan = vi.fn();
    const result = await runOpportunityDiscovery({
      query,
      adapters: [
        {
          manifest,
          discover: async () => [candidate("ignored")],
        },
      ],
      assessCandidate: async () => null,
      persistPlan,
    });

    expect(result.candidates_seen).toBe(1);
    expect(result.assessments_created).toBe(0);
    expect(result.plan).toBeNull();
    expect(result.persisted).toBeNull();
    expect(persistPlan).not.toHaveBeenCalled();
  });

  it("rejects evidence from a source that did not produce the candidate", async () => {
    const persistPlan = vi.fn();
    const result = await runOpportunityDiscovery({
      query,
      adapters: [{ manifest, discover: async () => [candidate("foreign-evidence")] }],
      assessCandidate: async ({ candidate: discovered }) => {
        const assessed = assessment(discovered);
        return {
          ...assessed,
          evidence: [{ ...assessed.evidence[0]!, source_id: "untrusted-source" }],
        };
      },
      persistPlan,
    });

    expect(result.assessments_created).toBe(0);
    expect(result.assessment_errors[0]?.message).toContain("untrusted-source");
    expect(persistPlan).not.toHaveBeenCalled();
  });

  it("discovers candidates via web-presence adapter and forces Copilot mode throughout the pipeline", async () => {
    const { createWebPresenceAdapter } =
      await import("@/lib/opportunity-intelligence/adapters/web-presence");
    const adapter = createWebPresenceAdapter({
      fetchRecords: async () => [
        {
          id: "biz-1",
          name: "Clínica Sorriso",
          domain: "clinicasorriso.com.br",
          phone_e164: "+5511988887777",
          has_whatsapp_cta: false,
          has_mobile_friendly_site: false,
          ssl_valid: true,
          page_speed_score: 32,
        },
      ],
    });

    const persistPlan = vi.fn(async (plan) => ({
      trace_id: plan.trace_id,
      organization_id: plan.organization_id,
      persisted_count: plan.items.length,
      results: [],
    }));

    const result = await runOpportunityDiscovery({
      query: { ...query, region: "br-sudeste" },
      adapters: [adapter],
      assessCandidate: async ({ candidate: discovered }) => ({
        opportunity_id: "00000000-0000-4000-8000-000000000055",
        candidate: discovered,
        required_signal_keys: ["missing_whatsapp"],
        signals: [
          {
            key: "missing_whatsapp",
            label: "Sem WhatsApp visível",
            evidence_ids: ["ev-1"],
            priority: "high",
          },
        ],
        evidence: [
          {
            evidence_id: "ev-1",
            source_id: adapter.manifest.source_id,
            source_kind: adapter.manifest.source_kind,
            source_url: discovered.source_url,
            terms_url: adapter.manifest.terms_url,
            policy_status: "verified_allowed",
            claim: discovered.facts.missing_conversion_channel ?? "Falta canal",
            signal_keys: ["missing_whatsapp"],
            polarity: "supports",
            confidence: 0.9,
            collected_at: discovered.collected_at,
            freshness_ttl_hours: 48,
          },
        ],
        strategy: {
          pain_hypothesis: "Perda de leads móveis",
          target_offer: "Widget de WhatsApp e landing page",
          proof_asset_summary: "Auditoria técnica com score mobile 32/100",
          evidence_ids: ["ev-1"],
        },
        tenant_policy: { require_human_approval: false },
        linked_lead_id: null,
        existing_lead: "none",
        suppressed: false,
      }),
      persistPlan,
    });

    expect(result.candidates_seen).toBe(1);
    expect(result.assessments_created).toBe(1);
    expect(result.plan?.items[0]?.decision.requires_human).toBe(true);
    expect(result.plan?.items[0]?.action_plan?.requires_human_approval).toBe(true);
    expect(persistPlan).toHaveBeenCalledOnce();
  });

  it("sanitizes domain with protocol and invalid phone numbers without crashing schema validation", async () => {
    const { createWebPresenceAdapter } =
      await import("@/lib/opportunity-intelligence/adapters/web-presence");
    const adapter = createWebPresenceAdapter({
      fetchRecords: async () => [
        {
          id: "biz-raw",
          name: "  Pet Shop Bicho Feliz  ",
          domain: "https://petfeliz.com.br/contato/",
          phone_e164: "(11) 99999-0000",
          has_whatsapp_cta: true,
          has_mobile_friendly_site: true,
          ssl_valid: true,
          page_speed_score: 85,
        },
      ],
    });

    const candidates = await adapter.discover(query);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.identity.domain).toBe("petfeliz.com.br/contato");
    expect(candidates[0]?.source_url).toBe("https://petfeliz.com.br/contato");
    expect(candidates[0]?.identity.display_name).toBe("Pet Shop Bicho Feliz");
    expect(candidates[0]?.identity.phone_e164).toBeUndefined();
  });

  it("fails closed when web-presence adapter manifest is configured with invalid terms", async () => {
    const { createWebPresenceAdapter } =
      await import("@/lib/opportunity-intelligence/adapters/web-presence");
    expect(() =>
      createWebPresenceAdapter(undefined, {
        terms_url: "not-a-valid-url" as never,
      }),
    ).toThrow();
  });
});

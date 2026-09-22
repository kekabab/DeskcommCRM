import { describe, expect, it } from "vitest";

import {
  applyOutcome,
  buildOpportunityIdempotencyKey,
  canonicalIdentityKey,
  evaluateOpportunity,
  unsupportedEvidenceIds,
  type OpportunityEvaluationInput,
} from "@/lib/opportunity-intelligence/domain";

const NOW = new Date("2026-09-20T15:00:00.000Z");
const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

function input(overrides: Partial<OpportunityEvaluationInput> = {}): OpportunityEvaluationInput {
  return {
    organization_id: ORGANIZATION_ID,
    linked_lead_id: null,
    required_signal_keys: ["missing_conversion_path", "active_demand"],
    signals: [
      {
        key: "missing_conversion_path",
        label: "No clear conversion path",
        evidence_ids: ["e-site"],
        priority: "high",
      },
      {
        key: "active_demand",
        label: "Recent public demand",
        evidence_ids: ["e-review"],
        priority: "high",
      },
    ],
    evidence: [
      {
        evidence_id: "e-site",
        source_id: "website-audit",
        source_kind: "official_api",
        source_url: "https://example.com/audit",
        terms_url: "https://example.com/terms",
        policy_status: "verified_allowed",
        claim: "The site has no visible conversion path.",
        signal_keys: ["missing_conversion_path"],
        polarity: "supports",
        confidence: 0.95,
        collected_at: "2026-09-20T14:00:00.000Z",
        freshness_ttl_hours: 48,
      },
      {
        evidence_id: "e-review",
        source_id: "public-reviews",
        source_kind: "open_data",
        source_url: "https://example.com/review/1",
        terms_url: "https://example.com/terms",
        policy_status: "verified_allowed",
        claim: "A recent review asks how to schedule an appointment.",
        signal_keys: ["active_demand"],
        polarity: "supports",
        confidence: 0.9,
        collected_at: "2026-09-20T13:00:00.000Z",
        freshness_ttl_hours: 72,
      },
    ],
    strategy: {
      pain_hypothesis: "The business is losing demand between discovery and booking.",
      target_offer: "A conversion-first landing page with a booking handoff.",
      proof_asset_summary: "Create a one-page audit showing the missing conversion path.",
      evidence_ids: ["e-site", "e-review"],
    },
    tenant_policy: { require_human_approval: false },
    existing_lead: "none",
    suppressed: false,
    ...overrides,
  };
}

describe("Opportunity Intelligence domain", () => {
  it("normalizes equivalent identities to one deduplication key", () => {
    expect(
      canonicalIdentityKey({
        display_name: "Clínica Aurora",
        domain: "https://www.Example.com/site",
      }),
    ).toBe("domain:example.com");
    expect(
      canonicalIdentityKey({
        display_name: "Clínica Aurora",
        domain: "example.com",
        phone_e164: "+5511999999999",
      }),
    ).toBe("domain:example.com");
    expect(
      canonicalIdentityKey({
        display_name: "Clínica Aurora",
        registry_id: "12.345.678/0001-90",
        domain: "example.com",
      }),
    ).toBe("registry:12345678000190");
  });

  it("scopes idempotency keys by tenant and source", () => {
    expect(
      buildOpportunityIdempotencyKey({
        organization_id: "org-a",
        source_id: "maps",
        external_id: "place/1",
      }),
    ).toBe("org-a:maps:place%2F1");
    expect(
      buildOpportunityIdempotencyKey({
        organization_id: "org-b",
        source_id: "maps",
        external_id: "place/1",
      }),
    ).not.toBe("org-a:maps:place%2F1");
  });

  it("prepares a draft only when all required signals have fresh evidence", () => {
    const decision = evaluateOpportunity(input(), NOW);

    expect(decision.state).toBe("action_ready");
    expect(decision.action).toBe("prepare_personalized_draft");
    expect(decision.requires_human).toBe(false);
    expect(decision.confidence).toBeGreaterThanOrEqual(0.75);
    expect(decision.fresh_evidence_ids).toEqual(["e-site", "e-review"]);
    expect(decision.recommended_action?.target_offer).toContain("landing page");
    expect(decision.organization_id).toBe(ORGANIZATION_ID);
  });

  it("does not autonomously act on stale evidence", () => {
    const decision = evaluateOpportunity(
      input({
        evidence: input().evidence.map((item) => ({
          ...item,
          collected_at: "2026-09-15T13:00:00.000Z",
          freshness_ttl_hours: 24,
        })),
      }),
      NOW,
    );

    expect(decision.state).toBe("stale");
    expect(decision.action).toBe("refresh_evidence");
    expect(decision.requires_human).toBe(false);
  });

  it("escalates contradictory evidence instead of guessing", () => {
    const firstEvidence = input().evidence[0]!;
    const decision = evaluateOpportunity(
      input({
        evidence: [
          ...input().evidence,
          {
            ...firstEvidence,
            evidence_id: "e-site-contradiction",
            polarity: "contradicts",
            claim: "The site has a working conversion path.",
          },
        ],
      }),
      NOW,
    );

    expect(decision.state).toBe("awaiting_human");
    expect(decision.action).toBe("request_human_review");
    expect(decision.exceptions.map((item) => item.code)).toContain("contradictory_evidence");
  });

  it("links an active CRM lead instead of creating a duplicate opportunity", () => {
    const decision = evaluateOpportunity(input({ existing_lead: "active" }), NOW);

    expect(decision.state).toBe("awaiting_human");
    expect(decision.action).toBe("link_existing_lead");
    expect(decision.requires_human).toBe(true);
  });

  it("blocks suppressed recipients before any action", () => {
    const decision = evaluateOpportunity(input({ suppressed: true }), NOW);

    expect(decision.state).toBe("suppressed");
    expect(decision.action).toBe("suppress");
    expect(decision.requires_human).toBe(false);
  });

  it("identifies claims that have no fresh, allowed evidence", () => {
    expect(
      unsupportedEvidenceIds([{ evidence_ids: ["e-site", "missing"] }], input().evidence, NOW),
    ).toEqual(["missing"]);
  });

  it("does not accept a signal that cites evidence absent from the payload", () => {
    const decision = evaluateOpportunity(
      input({
        signals: [{ ...input().signals[0]!, evidence_ids: ["not-supplied"] }],
      }),
      NOW,
    );

    expect(decision.state).toBe("awaiting_human");
    expect(decision.action).toBe("request_human_review");
    expect(decision.exceptions.map((item) => item.code)).toContain("signal_without_evidence");
  });

  it("forces tenant approval even when evidence is strong", () => {
    const decision = evaluateOpportunity(
      input({ tenant_policy: { require_human_approval: true } }),
      NOW,
    );

    expect(decision.state).toBe("awaiting_human");
    expect(decision.requires_human).toBe(true);
    expect(decision.exceptions.map((item) => item.code)).toContain("tenant_requires_approval");
  });

  it("does not allow a value hypothesis to outrun its evidence", () => {
    const decision = evaluateOpportunity(
      input({
        strategy: {
          ...input().strategy!,
          evidence_ids: ["e-not-present"],
        },
      }),
      NOW,
    );

    expect(decision.state).toBe("awaiting_human");
    expect(decision.exceptions.map((item) => item.code)).toContain("unsupported_claim");
  });

  it("closes the loop with an auditable outcome state", () => {
    const base = {
      outcome_id: "00000000-0000-4000-8000-000000000002",
      organization_id: ORGANIZATION_ID,
      opportunity_id: "00000000-0000-4000-8000-000000000003",
      action_id: null,
      reason: null,
      occurred_at: "2026-09-20T16:00:00.000Z",
      metrics: {},
    } as const;

    expect(applyOutcome("action_ready", { ...base, kind: "meeting" })).toBe("engaged");
    expect(applyOutcome("engaged", { ...base, kind: "deal_won" })).toBe("converted");
    expect(applyOutcome("engaged", { ...base, kind: "unsubscribed" })).toBe("suppressed");
  });
});

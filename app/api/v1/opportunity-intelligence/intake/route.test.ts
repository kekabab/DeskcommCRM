import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { planOpportunityPipeline } from "@/lib/opportunity-intelligence/pipeline";
import { persistOpportunityPipelinePlan } from "@/lib/opportunity-intelligence/write";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/opportunity-intelligence/pipeline", () => ({ planOpportunityPipeline: vi.fn() }));
vi.mock("@/lib/opportunity-intelligence/write", () => ({
  persistOpportunityPipelinePlan: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OPPORTUNITY_ID = "33333333-3333-4333-8333-333333333333";
const TRACE_ID = "44444444-4444-4444-8444-444444444444";

const body = {
  trace_id: TRACE_ID,
  opportunity_id: OPPORTUNITY_ID,
  region: "sao-paulo",
  source_manifest: {
    source_id: "authorized.directory",
    source_kind: "official_api",
    terms_url: "https://source.example/terms",
    allow_automated_collection: true,
    rate_limit_per_minute: 30,
    supports_regions: ["sao-paulo"],
  },
  candidate: {
    source_id: "authorized.directory",
    external_id: "company-1",
    identity: { display_name: "Company One", domain: "https://company.example" },
    collected_at: "2026-09-20T16:00:00.000Z",
    source_url: "https://source.example/company-1",
    facts: { category: "digital services" },
  },
  required_signal_keys: ["website.missing"],
  signals: [
    { key: "website.missing", label: "Website ausente", evidence_ids: ["ev-1"], priority: "high" },
  ],
  evidence: [
    {
      evidence_id: "ev-1",
      source_id: "authorized.directory",
      source_kind: "official_api",
      source_url: "https://source.example/company-1",
      terms_url: "https://source.example/terms",
      policy_status: "verified_allowed",
      claim: "A fonte autorizada não encontrou website público.",
      signal_keys: ["website.missing"],
      polarity: "supports",
      confidence: 0.92,
      collected_at: "2026-09-20T16:00:00.000Z",
      freshness_ttl_hours: 24,
    },
  ],
  strategy: {
    pain_hypothesis: "A empresa pode estar perdendo demanda por não ter presença digital própria.",
    target_offer: "Diagnóstico de presença digital",
    proof_asset_summary: "Mini diagnóstico com fonte, data e comparação de presença.",
    evidence_ids: ["ev-1"],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  const emptyQuery = {
    select: vi.fn(() => emptyQuery),
    eq: vi.fn(() => emptyQuery),
    ilike: vi.fn(() => emptyQuery),
    order: vi.fn(() => emptyQuery),
    limit: vi.fn(() => emptyQuery),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
  };
  const sourceQuery = {
    select: vi.fn(() => sourceQuery),
    eq: vi.fn(() => sourceQuery),
    maybeSingle: vi.fn(async () => ({
      data: {
        source_id: body.source_manifest.source_id,
        source_kind: body.source_manifest.source_kind,
        terms_url: body.source_manifest.terms_url,
        regions: body.source_manifest.supports_regions,
        rate_limit_per_minute: body.source_manifest.rate_limit_per_minute,
        is_active: true,
      },
      error: null,
    })),
  };
  vi.mocked(createAdminClient).mockReturnValue({
    from: vi.fn((table: string) =>
      table === "opportunity_source_configs" ? sourceQuery : emptyQuery,
    ),
  } as never);
  vi.mocked(planOpportunityPipeline).mockReturnValue({
    trace_id: TRACE_ID,
    schema_version: 1,
    organization_id: ORG_ID,
    items: [{ decision: { state: "awaiting_human" }, opportunity_id: OPPORTUNITY_ID }],
  } as never);
  vi.mocked(persistOpportunityPipelinePlan).mockResolvedValue({
    trace_id: TRACE_ID,
    organization_id: ORG_ID,
    persisted_count: 1,
    results: [
      {
        opportunity_id: OPPORTUNITY_ID,
        identity_key: "domain:company.example",
        state: "awaiting_human",
        action_id: null,
        evidence_count: 1,
        events_emitted: 2,
      },
    ],
  });
});

function request(value: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/opportunity-intelligence/intake", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/opportunity-intelligence/intake", () => {
  it("bloqueia fonte sem permissão de coleta automática", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      request({
        ...body,
        source_manifest: { ...body.source_manifest, allow_automated_collection: false },
      }),
    );
    expect(response.status).toBe(422);
    expect(planOpportunityPipeline).not.toHaveBeenCalled();
  });

  it("força Copiloto e deriva a organização pela sessão", async () => {
    const { POST } = await import("./route");
    const response = await POST(request(body));

    expect(response.status).toBe(201);
    expect(planOpportunityPipeline).toHaveBeenCalledWith(
      expect.objectContaining({ organization_id: ORG_ID }),
    );
    expect(
      vi.mocked(planOpportunityPipeline).mock.calls[0]?.[0].assessments[0]?.tenant_policy,
    ).toEqual({ require_human_approval: true });
    expect(persistOpportunityPipelinePlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        actor_user_id: "11111111-1111-4111-8111-111111111111",
      },
    );
  });

  it("marca como suprimido um contato bloqueado mesmo sem linked_lead_id no payload", async () => {
    const makeQuery = (result: unknown) => {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        ilike: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: result, error: null })),
      };
      return query;
    };
    vi.mocked(createAdminClient).mockReturnValue({
      from: vi.fn((table: string) => {
        if (table === "opportunity_source_configs") {
          return makeQuery({
            source_id: body.source_manifest.source_id,
            source_kind: body.source_manifest.source_kind,
            terms_url: body.source_manifest.terms_url,
            regions: body.source_manifest.supports_regions,
            rate_limit_per_minute: body.source_manifest.rate_limit_per_minute,
            is_active: true,
          });
        }
        return table === "contacts"
          ? makeQuery({ id: "55555555-5555-4555-8555-555555555555", is_blocked: true })
          : makeQuery(null);
      }),
    } as never);

    const { POST } = await import("./route");
    const response = await POST(request(body));

    expect(response.status).toBe(201);
    expect(vi.mocked(planOpportunityPipeline).mock.calls[0]?.[0].assessments[0]?.suppressed).toBe(
      true,
    );
  });
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { loadOpportunityDossier } from "@/lib/opportunity-intelligence/read";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/opportunity-intelligence/read", () => ({
  loadOpportunityDossier: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OPPORTUNITY_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createClient).mockResolvedValue({} as never);
});

function request(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/opportunity-intelligence/dossier/${OPPORTUNITY_ID}`,
  );
}

describe("GET /api/v1/opportunity-intelligence/dossier/[id]", () => {
  it("retorna 404 quando o dossiê não existe ou pertence a outra organização", async () => {
    const { GET } = await import("./route");
    vi.mocked(loadOpportunityDossier).mockResolvedValue(null);

    const res = await GET(request(), {
      params: Promise.resolve({ id: OPPORTUNITY_ID }),
    });

    expect(res.status).toBe(404);
    expect(loadOpportunityDossier).toHaveBeenCalledWith(expect.anything(), ORG_ID, OPPORTUNITY_ID);
  });

  it("retorna 200 com os dados FACT do dossiê quando encontrado", async () => {
    const { GET } = await import("./route");
    vi.mocked(loadOpportunityDossier).mockResolvedValue({
      record: { id: OPPORTUNITY_ID, display_name: "Empresa Teste" } as never,
      evidence: [],
      actions: [],
      outcomes: [],
      fact: {
        facts: [{ claim: "Site lento", confidence: 0.9 }],
        anchors: [],
        consequence: { pain_hypothesis: "Perda de clientes", inaction_risk: null },
        tangible_proof: { target_offer: "Otimização", proof_asset_summary: "Diagnóstico" },
      },
      active_action: null,
    });

    const res = await GET(request(), {
      params: Promise.resolve({ id: OPPORTUNITY_ID }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      data: {
        record: { id: OPPORTUNITY_ID, display_name: "Empresa Teste" },
        fact: {
          facts: [{ claim: "Site lento" }],
        },
      },
    });
  });
});

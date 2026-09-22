import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { reviewOpportunityAction } from "@/lib/opportunity-intelligence/write";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/opportunity-intelligence/write", () => ({
  reviewOpportunityAction: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ACTION_ID = "55555555-5555-4555-8555-555555555555";
const OPPORTUNITY_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({} as never);
  vi.mocked(reviewOpportunityAction).mockResolvedValue({
    action_id: ACTION_ID,
    opportunity_id: OPPORTUNITY_ID,
    status: "approved",
    previous_status: "proposed",
    opportunity_state: "action_ready",
    event_emitted: true,
  });
});

function request(body: string): NextRequest {
  return new NextRequest(`http://localhost/api/v1/opportunity-intelligence/actions/${ACTION_ID}`, {
    method: "PATCH",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("PATCH /api/v1/opportunity-intelligence/actions/[id]", () => {
  it("valida body e rejeita payload malformado", async () => {
    const { PATCH } = await import("./route");

    const malformed = await PATCH(request("{"), {
      params: Promise.resolve({ id: ACTION_ID }),
    });
    expect(malformed.status).toBe(400);

    const invalid = await PATCH(request(JSON.stringify({ status: "invalid_status" })), {
      params: Promise.resolve({ id: ACTION_ID }),
    });
    expect(invalid.status).toBe(422);
    expect(reviewOpportunityAction).not.toHaveBeenCalled();
  });

  it("aprova ação de oportunidade respeitando tenant da sessão", async () => {
    const { PATCH } = await import("./route");

    const response = await PATCH(request(JSON.stringify({ status: "approved" })), {
      params: Promise.resolve({ id: ACTION_ID }),
    });

    expect(response.status).toBe(200);
    expect(reviewOpportunityAction).toHaveBeenCalledWith(expect.anything(), {
      action_id: ACTION_ID,
      organization_id: ORG_ID,
      status: "approved",
      user_id: "11111111-1111-4111-8111-111111111111",
      reason: null,
      lead_id: null,
    });
    await expect(response.json()).resolves.toMatchObject({
      data: {
        action_id: ACTION_ID,
        status: "approved",
        opportunity_state: "action_ready",
        event_emitted: true,
      },
    });
  });

  it("trata conflito ao tentar aprovar ação já executada ou bloqueada", async () => {
    const { PATCH } = await import("./route");
    vi.mocked(reviewOpportunityAction).mockRejectedValue(
      new Error("cannot_modify_executed_action"),
    );

    const response = await PATCH(request(JSON.stringify({ status: "approved" })), {
      params: Promise.resolve({ id: ACTION_ID }),
    });

    expect(response.status).toBe(409);
  });
});

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { recordOpportunityOutcome } from "@/lib/opportunity-intelligence/write";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/opportunity-intelligence/write", () => ({
  recordOpportunityOutcome: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OPPORTUNITY_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: "11111111-1111-4111-8111-111111111111" },
    org: { orgId: ORG_ID },
  } as never);
  vi.mocked(createAdminClient).mockReturnValue({} as never);
  vi.mocked(recordOpportunityOutcome).mockResolvedValue({
    outcome_id: "44444444-4444-4444-8444-444444444444",
    opportunity_id: OPPORTUNITY_ID,
    previous_state: "contacted",
    new_state: "engaged",
    event_emitted: true,
  });
});

function request(body: string): NextRequest {
  return new NextRequest("http://localhost/api/v1/opportunity-intelligence/outcomes", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

describe("POST /api/v1/opportunity-intelligence/outcomes", () => {
  it("valida JSON e body antes de tocar no writer", async () => {
    const { POST } = await import("./route");

    const malformed = await POST(request("{"));
    expect(malformed.status).toBe(400);

    const invalid = await POST(request(JSON.stringify({ opportunity_id: OPPORTUNITY_ID })));
    expect(invalid.status).toBe(422);
    expect(recordOpportunityOutcome).not.toHaveBeenCalled();
  });

  it("usa a organização da sessão e mantém o outcome idempotente", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      request(
        JSON.stringify({
          opportunity_id: OPPORTUNITY_ID,
          idempotency_key: "opp-meeting-001",
          kind: "meeting",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(recordOpportunityOutcome).toHaveBeenCalledWith(expect.anything(), {
      opportunity_id: OPPORTUNITY_ID,
      idempotency_key: "opp-meeting-001",
      kind: "meeting",
      organization_id: ORG_ID,
      user_id: "11111111-1111-4111-8111-111111111111",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { new_state: "engaged", event_emitted: true },
    });
  });
});

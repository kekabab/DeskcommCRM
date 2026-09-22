import { describe, expect, it } from "vitest";

import { applyOutcome, evaluateOpportunity } from "@/lib/opportunity-intelligence/domain";
import { GOLDEN_OPPORTUNITY_FIXTURES } from "@/lib/opportunity-intelligence/golden-fixtures";

describe("Opportunity Intelligence golden fixtures", () => {
  it.each(GOLDEN_OPPORTUNITY_FIXTURES)("$case_id follows its safety contract", (fixture) => {
    const decision = evaluateOpportunity(fixture.input, new Date("2026-09-20T16:00:00.000Z"));

    expect({
      state: decision.state,
      action: decision.action,
      requires_human: decision.requires_human,
    }).toEqual(fixture.expected);
  });

  it("closes the positive path and keeps opt-out terminal", () => {
    const positive = GOLDEN_OPPORTUNITY_FIXTURES[0]!;
    const decision = evaluateOpportunity(positive.input, new Date("2026-09-20T16:00:00.000Z"));
    const outcomeBase = {
      outcome_id: "00000000-0000-4000-8000-000000000020",
      organization_id: positive.input.organization_id,
      opportunity_id: "00000000-0000-4000-8000-000000000021",
      action_id: null,
      reason: null,
      occurred_at: "2026-09-20T16:00:00.000Z",
      metrics: {},
    } as const;

    expect(applyOutcome(decision.state, { ...outcomeBase, kind: "meeting" })).toBe("engaged");
    expect(applyOutcome("engaged", { ...outcomeBase, kind: "deal_won" })).toBe("converted");
    expect(applyOutcome("engaged", { ...outcomeBase, kind: "unsubscribed" })).toBe("suppressed");
    expect(applyOutcome("suppressed", { ...outcomeBase, kind: "deal_won" })).toBe("suppressed");
  });
});

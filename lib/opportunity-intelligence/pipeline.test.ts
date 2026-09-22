import { describe, expect, it } from "vitest";

import { canonicalIdentityKey } from "@/lib/opportunity-intelligence/domain";
import { GOLDEN_OPPORTUNITY_FIXTURES } from "@/lib/opportunity-intelligence/golden-fixtures";
import {
  planOpportunityPipeline,
  type OpportunityPipelineAssessment,
} from "@/lib/opportunity-intelligence/pipeline";

function assessment(
  overrides: Partial<OpportunityPipelineAssessment> = {},
): OpportunityPipelineAssessment {
  const input = GOLDEN_OPPORTUNITY_FIXTURES[0]!.input;
  const identity = { display_name: "Mock Corp", domain: "mock-corp.example" };
  return {
    opportunity_id: "00000000-0000-4000-8000-000000000099",
    candidate: {
      source_id: "synthetic-public-source",
      external_id: "mock-corp-01",
      identity,
      collected_at: "2026-09-20T15:00:00.000Z",
      source_url: "https://synthetic.example/mock-corp-01",
      facts: {},
      identity_key: canonicalIdentityKey(identity),
      duplicate_source_ids: [],
    },
    required_signal_keys: input.required_signal_keys,
    signals: input.signals,
    evidence: input.evidence,
    strategy: input.strategy,
    tenant_policy: input.tenant_policy,
    linked_lead_id: input.linked_lead_id,
    existing_lead: input.existing_lead,
    suppressed: input.suppressed,
    ...overrides,
  };
}

describe("Opportunity Intelligence pipeline plan", () => {
  it("creates an internal action and two canonical events for a strong candidate", () => {
    const plan = planOpportunityPipeline({
      trace_id: "00000000-0000-4000-8000-000000000090",
      schema_version: 1,
      organization_id: "00000000-0000-4000-8000-000000000001",
      assessments: [assessment()],
      now: new Date("2026-09-20T16:00:00.000Z"),
    });
    const item = plan.items[0]!;

    expect(item.decision.state).toBe("action_ready");
    expect(item.action_plan).toMatchObject({
      action: "prepare_personalized_draft",
      status: "proposed",
      requires_human_approval: false,
      pain_hypothesis: "Demand is being lost between discovery and contact.",
    });
    expect(item.events.map((event) => event.event_type)).toEqual([
      "opportunity.signal_detected",
      "opportunity.ready_for_action",
    ]);
    expect(
      item.events.every(
        (event) => event.payload.trace_id === "00000000-0000-4000-8000-000000000090",
      ),
    ).toBe(true);
  });

  it("preserves the tenant approval gate and never turns it into an outbound action", () => {
    const plan = planOpportunityPipeline({
      trace_id: "00000000-0000-4000-8000-000000000091",
      schema_version: 1,
      organization_id: "00000000-0000-4000-8000-000000000001",
      assessments: [assessment({ tenant_policy: { require_human_approval: true } })],
      now: new Date("2026-09-20T16:00:00.000Z"),
    });
    const item = plan.items[0]!;

    expect(item.decision.state).toBe("awaiting_human");
    expect(item.action_plan.action).toBe("request_human_review");
    expect(item.action_plan.requires_human_approval).toBe(true);
    expect(item.events[1]?.event_type).toBe("opportunity.exception_raised");
    expect(item.events.map((event) => event.event_type)).not.toContain("message.send");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  linkOpportunityToLead,
  persistOpportunityPipelinePlan,
  recordOpportunityOutcome,
  reviewOpportunityAction,
} from "@/lib/opportunity-intelligence/write";
import { planOpportunityPipeline } from "@/lib/opportunity-intelligence/pipeline";
import { GOLDEN_OPPORTUNITY_FIXTURES } from "@/lib/opportunity-intelligence/golden-fixtures";
import type { OpportunityPipelineAssessment } from "@/lib/opportunity-intelligence/pipeline";
import { ACTIVITY_LABELS, type ActivityType } from "@/lib/leads/activity-vocabulary";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";
const OPPORTUNITY_ID = "00000000-0000-4000-8000-000000000010";
const ACTION_ID = "00000000-0000-0000-0000-000000000011";
const USER_ID = "00000000-0000-0000-0000-000000000012";

type MockRow = Record<string, unknown>;
type MockTableName =
  | "opportunity_records"
  | "opportunity_evidence"
  | "opportunity_actions"
  | "opportunity_outcomes"
  | "event_log"
  | "api_audit_log"
  | "crm_lead_activities";
type MockTables = Record<MockTableName, MockRow[]>;

type MockUpsertQuery = {
  select: () => {
    single: () => Promise<{ data: MockRow; error: null }>;
    maybeSingle: () => Promise<{ data: MockRow; error: null }>;
  };
};

type MockInsertQuery = Promise<{ data: MockRow[]; error: null }> & {
  select: () => {
    single: () => Promise<{ data: MockRow; error: null }>;
    maybeSingle: () => Promise<{ data: MockRow; error: null }>;
  };
};

type MockQuery = {
  select: () => MockQuery;
  eq: (column: string, value: unknown) => MockQuery;
  in: (column: string, values: unknown[]) => MockQuery;
  order: () => MockQuery;
  limit: () => MockQuery;
  maybeSingle: () => Promise<{ data: MockRow | null; error: null }>;
  single: () => Promise<{ data: MockRow; error: null }>;
  upsert: (rows: MockRow | MockRow[], options?: unknown) => MockUpsertQuery;
  insert: (rows: MockRow | MockRow[]) => MockInsertQuery;
  update: (values: MockRow) => MockQuery;
};

type MockClient = {
  from: (tableName: MockTableName) => MockQuery;
  rpc: (
    functionName: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: Error | null }>;
  _tables: MockTables;
};

function asSupabaseClient(client: MockClient): SupabaseClient {
  return client as unknown as SupabaseClient;
}

function createMockSupabase() {
  const tables: MockTables = {
    opportunity_records: [],
    opportunity_evidence: [],
    opportunity_actions: [],
    opportunity_outcomes: [],
    event_log: [],
    api_audit_log: [],
    crm_lead_activities: [],
  };

  const client: MockClient = {
    from: vi.fn((tableName: MockTableName) => {
      const currentTable = tableName;
      let filterKey: string | null = null;
      let filterId: string | null = null;
      const filters: Record<string, string> = {};

      const matches = (row: MockRow) => {
        if (filterId && row.id !== filterId) return false;
        if (filterKey && row.identity_key !== filterKey) return false;
        for (const [key, value] of Object.entries(filters)) {
          if (key === "metadata_idempotency_key") {
            const metadata = row.metadata as Record<string, unknown> | undefined;
            if (metadata?.idempotency_key !== value) return false;
          } else if (row[key] !== value) {
            return false;
          }
        }
        return true;
      };

      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((col: string, value: unknown) => {
          if (col === "identity_key" && typeof value === "string") filterKey = value;
          if (col === "id" && typeof value === "string") filterId = value;
          if (col === "organization_id" && typeof value === "string")
            filters.organization_id = value;
          if (col === "event_type" && typeof value === "string") filters.event_type = value;
          if (col === "entity_id" && typeof value === "string") filters.entity_id = value;
          if (col === "idempotency_key" && typeof value === "string")
            filters.idempotency_key = value;
          if (col === "metadata->>idempotency_key" && typeof value === "string")
            filters.metadata_idempotency_key = value;
          return query;
        }),
        in: vi.fn((_col: string, _values: unknown[]) => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => {
          const match = tables[currentTable]?.find(matches);
          return { data: match ?? null, error: null };
        }),
        single: vi.fn(async () => {
          const match = tables[currentTable]?.find(matches);
          return {
            data: match ?? { id: filterId ?? OPPORTUNITY_ID, state: "discovered" },
            error: null,
          };
        }),
        upsert: vi.fn((rows: MockRow | MockRow[], _options?: unknown) => {
          const rowArray = Array.isArray(rows) ? rows : [rows];
          for (const r of rowArray) {
            const saved = { ...r, id: r.id ?? OPPORTUNITY_ID };
            tables[currentTable] = tables[currentTable] || [];
            tables[currentTable].push(saved);
          }
          return {
            data: rowArray[0]
              ? { id: rowArray[0].id ?? OPPORTUNITY_ID, state: rowArray[0].state }
              : null,
            error: null,
            select: vi.fn(() => ({
              single: vi.fn(async () => ({
                data: { id: rowArray[0]?.id ?? OPPORTUNITY_ID, state: rowArray[0]?.state },
                error: null,
              })),
              maybeSingle: vi.fn(async () => ({
                data: { id: rowArray[0]?.id ?? OPPORTUNITY_ID },
                error: null,
              })),
            })),
          };
        }),
        insert: vi.fn((rows: MockRow | MockRow[]) => {
          const rowArray = Array.isArray(rows) ? rows : [rows];
          tables[currentTable] = tables[currentTable] || [];
          const savedRows = rowArray.map((r) => ({ id: r.id ?? "activity-uuid-1", ...r }));
          tables[currentTable].push(...savedRows);
          const resultPromise = Promise.resolve({ data: savedRows, error: null });
          return Object.assign(resultPromise, {
            select: vi.fn(() => ({
              single: vi.fn(async () => ({ data: savedRows[0], error: null })),
              maybeSingle: vi.fn(async () => ({ data: savedRows[0], error: null })),
            })),
          });
        }),
        update: vi.fn((values: MockRow) => {
          const match = tables[currentTable]?.find(matches);
          if (match) {
            Object.assign(match, values);
          }
          return query;
        }),
      } as MockQuery;
      return query;
    }),
    rpc: vi.fn(async (functionName: string, args: Record<string, unknown>) => {
      if (functionName === "persist_opportunity_pipeline_plan") {
        const rpcPlan = args.p_plan as {
          trace_id: string;
          organization_id: string;
          items: Array<Record<string, unknown>>;
        };
        const results: MockRow[] = [];

        for (const item of rpcPlan.items) {
          const assessment = item.assessment as Record<string, unknown>;
          const candidate = assessment.candidate as Record<string, unknown>;
          const identity = candidate.identity as Record<string, unknown>;
          const decision = item.decision as Record<string, unknown>;
          const actionPlan = item.action_plan as Record<string, unknown>;
          const identityKey = String(item.identity_key);
          const existing = tables.opportunity_records.find(
            (row) =>
              row.organization_id === rpcPlan.organization_id && row.identity_key === identityKey,
          );
          if (existing?.state === "suppressed" && decision.state !== "suppressed") {
            results.push({
              opportunity_id: existing.id,
              identity_key: identityKey,
              state: "suppressed",
              action_id: null,
              evidence_count: 0,
              events_emitted: 0,
            });
            continue;
          }

          const record = existing ?? {
            id: item.opportunity_id,
            organization_id: rpcPlan.organization_id,
            identity_key: identityKey,
          };
          Object.assign(record, {
            linked_lead_id: decision.linked_lead_id,
            display_name: identity.display_name,
            domain: identity.domain ?? null,
            state: decision.state,
            confidence: decision.confidence,
            signals: assessment.signals,
          });
          if (!existing) tables.opportunity_records.push(record);

          const evidence = (assessment.evidence as Array<Record<string, unknown>>) ?? [];
          for (const ev of evidence) {
            if (!tables.opportunity_evidence.some((row) => row.evidence_key === ev.evidence_id)) {
              tables.opportunity_evidence.push({
                id: `evidence-${tables.opportunity_evidence.length + 1}`,
                organization_id: rpcPlan.organization_id,
                opportunity_id: record.id,
                evidence_key: ev.evidence_id,
              });
            }
          }

          let actionId: string | null = null;
          if (decision.state !== "suppressed") {
            const existingAction = tables.opportunity_actions.find(
              (row) =>
                row.organization_id === rpcPlan.organization_id &&
                (row.idempotency_key === actionPlan.idempotency_key ||
                  row.opportunity_id === record.id),
            );
            actionId = String(
              existingAction?.id ?? `action-${tables.opportunity_actions.length + 1}`,
            );
            if (!existingAction) {
              tables.opportunity_actions.push({
                id: actionId,
                organization_id: rpcPlan.organization_id,
                opportunity_id: record.id,
                idempotency_key: actionPlan.idempotency_key,
                status: "proposed",
                requires_human_approval: true,
              });
            }
          }

          let eventsEmitted = 0;
          const events = (item.events as Array<Record<string, unknown>>) ?? [];
          for (const event of events) {
            const metadata = event.metadata as Record<string, unknown>;
            const duplicate = tables.event_log.some(
              (row) =>
                row.organization_id === rpcPlan.organization_id &&
                row.event_type === event.event_type &&
                (row.metadata as Record<string, unknown> | undefined)?.idempotency_key ===
                  metadata.idempotency_key,
            );
            if (!duplicate) {
              tables.event_log.push({
                id: `event-${tables.event_log.length + 1}`,
                organization_id: rpcPlan.organization_id,
                event_type: event.event_type,
                entity_id: record.id,
                metadata,
              });
              eventsEmitted += 1;
            }
          }

          tables.api_audit_log.push({
            id: `audit-${tables.api_audit_log.length + 1}`,
            organization_id: rpcPlan.organization_id,
            resource_id: record.id,
          });
          results.push({
            opportunity_id: record.id,
            identity_key: identityKey,
            state: decision.state,
            action_id: actionId,
            evidence_count: evidence.length,
            events_emitted: eventsEmitted,
          });
        }

        return {
          data: {
            trace_id: rpcPlan.trace_id,
            organization_id: rpcPlan.organization_id,
            persisted_count: results.length,
            results,
          },
          error: null,
        };
      }
      if (functionName === "emit_event") {
        const eventId = `event-${tables.event_log.length + 1}`;
        tables.event_log.push({
          id: eventId,
          organization_id: args.p_organization_id,
          event_type: args.p_event_type,
          entity_kind: args.p_entity_kind,
          entity_id: args.p_entity_id,
          payload: args.p_payload,
          metadata: args.p_metadata,
        });
        return { data: eventId, error: null };
      }
      return { data: "rpc-result", error: null };
    }),
    _tables: tables,
  };

  return client;
}

describe("Opportunity Intelligence persistence (write.ts)", () => {
  it("persists an action_ready pipeline plan into all 4 layers plus event_log", async () => {
    const positive = GOLDEN_OPPORTUNITY_FIXTURES[0]!;
    const assessment: OpportunityPipelineAssessment = {
      opportunity_id: OPPORTUNITY_ID,
      candidate: {
        identity: { display_name: "Mock Corp", domain: "https://mock.example" },
        identity_key: "domain:mock.example",
        source_id: "synthetic-source",
        external_id: "ext-1",
        collected_at: "2026-09-20T15:00:00.000Z",
        source_url: "https://synthetic.example/ext-1",
        facts: {},
        duplicate_source_ids: [],
      },
      required_signal_keys: positive.input.required_signal_keys,
      signals: positive.input.signals,
      evidence: positive.input.evidence,
      strategy: positive.input.strategy,
      tenant_policy: positive.input.tenant_policy,
      linked_lead_id: null,
      existing_lead: "none",
      suppressed: false,
    };

    const plan = planOpportunityPipeline({
      trace_id: "00000000-0000-4000-8000-000000000099",
      schema_version: 1,
      organization_id: ORGANIZATION_ID,
      assessments: [assessment],
      now: new Date("2026-09-20T16:00:00.000Z"),
    });

    const mockClient = createMockSupabase();
    const result = await persistOpportunityPipelinePlan(asSupabaseClient(mockClient), plan, [
      assessment,
    ]);

    expect(result.persisted_count).toBe(1);
    expect(result.results[0]?.state).toBe("action_ready");
    expect(result.results[0]?.evidence_count).toBe(2);
    expect(result.results[0]?.events_emitted).toBe(2);

    expect(mockClient._tables.event_log.length).toBe(2);
    expect(mockClient._tables.api_audit_log.length).toBe(1);

    const replay = await persistOpportunityPipelinePlan(asSupabaseClient(mockClient), plan, [
      assessment,
    ]);
    expect(replay.results[0]?.events_emitted).toBe(0);
    expect(mockClient._tables.event_log.length).toBe(2);
  });

  it("does not allow reopening an already suppressed opportunity", async () => {
    const mockClient = createMockSupabase();
    // Pre-populate suppressed record
    mockClient._tables.opportunity_records.push({
      id: OPPORTUNITY_ID,
      organization_id: ORGANIZATION_ID,
      identity_key: "domain:mock.example",
      state: "suppressed",
    });

    const positive = GOLDEN_OPPORTUNITY_FIXTURES[0]!;
    const assessment: OpportunityPipelineAssessment = {
      opportunity_id: OPPORTUNITY_ID,
      candidate: {
        identity: { display_name: "Mock Corp", domain: "https://mock.example" },
        identity_key: "domain:mock.example",
        source_id: "synthetic-source",
        external_id: "ext-1",
        collected_at: "2026-09-20T15:00:00.000Z",
        source_url: "https://synthetic.example/ext-1",
        facts: {},
        duplicate_source_ids: [],
      },
      required_signal_keys: positive.input.required_signal_keys,
      signals: positive.input.signals,
      evidence: positive.input.evidence,
      strategy: positive.input.strategy,
      tenant_policy: positive.input.tenant_policy,
      linked_lead_id: null,
      existing_lead: "none",
      suppressed: false, // incoming says not suppressed, but DB is already suppressed!
    };

    const plan = planOpportunityPipeline({
      trace_id: "00000000-0000-4000-8000-000000000099",
      schema_version: 1,
      organization_id: ORGANIZATION_ID,
      assessments: [assessment],
    });

    const result = await persistOpportunityPipelinePlan(asSupabaseClient(mockClient), plan, [
      assessment,
    ]);

    expect(result.results[0]?.state).toBe("suppressed");
    expect(result.results[0]?.events_emitted).toBe(0);
  });

  it("records an outcome, advances state, and emits opportunity.outcome_recorded", async () => {
    const mockClient = createMockSupabase();
    mockClient._tables.opportunity_records.push({
      id: OPPORTUNITY_ID,
      organization_id: ORGANIZATION_ID,
      state: "contacted",
    });

    const outcomeResult = await recordOpportunityOutcome(asSupabaseClient(mockClient), {
      organization_id: ORGANIZATION_ID,
      opportunity_id: OPPORTUNITY_ID,
      idempotency_key: "idemp-meeting-1",
      kind: "meeting",
    });

    expect(outcomeResult.previous_state).toBe("contacted");
    expect(outcomeResult.new_state).toBe("engaged");
    expect(outcomeResult.event_emitted).toBe(true);

    const outcomeEvent = mockClient._tables.event_log.find(
      (event) => event.event_type === "opportunity.outcome_recorded",
    );
    expect(outcomeEvent).toBeDefined();
    expect((outcomeEvent?.payload as Record<string, unknown>).new_state).toBe("engaged");

    const replay = await recordOpportunityOutcome(asSupabaseClient(mockClient), {
      organization_id: ORGANIZATION_ID,
      opportunity_id: OPPORTUNITY_ID,
      idempotency_key: "idemp-meeting-1",
      kind: "meeting",
    });

    expect(replay.event_emitted).toBe(false);
    expect(mockClient._tables.event_log).toHaveLength(1);
  });

  it("rejects recording an outcome if the opportunity is already suppressed", async () => {
    const mockClient = createMockSupabase();
    mockClient._tables.opportunity_records.push({
      id: OPPORTUNITY_ID,
      organization_id: ORGANIZATION_ID,
      state: "suppressed",
    });

    await expect(
      recordOpportunityOutcome(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        idempotency_key: "idemp-won-1",
        kind: "deal_won",
      }),
    ).rejects.toThrow("cannot_record_outcome_on_suppressed_opportunity");
  });

  it("reconciles a persisted outcome after a crash before event emission", async () => {
    const mockClient = createMockSupabase();
    mockClient._tables.opportunity_records.push({
      id: OPPORTUNITY_ID,
      organization_id: ORGANIZATION_ID,
      state: "contacted",
    });
    mockClient._tables.opportunity_outcomes.push({
      id: OPPORTUNITY_ID,
      organization_id: ORGANIZATION_ID,
      opportunity_id: OPPORTUNITY_ID,
      action_id: null,
      idempotency_key: "idemp-crashed-1",
      kind: "meeting",
      reason: null,
      occurred_at: "2026-09-20T16:00:00.000Z",
      metrics: {},
    });

    const result = await recordOpportunityOutcome(asSupabaseClient(mockClient), {
      organization_id: ORGANIZATION_ID,
      opportunity_id: OPPORTUNITY_ID,
      idempotency_key: "idemp-crashed-1",
      kind: "meeting",
    });

    expect(result.previous_state).toBe("contacted");
    expect(result.new_state).toBe("engaged");
    expect(result.event_emitted).toBe(true);
    expect(mockClient._tables.event_log).toHaveLength(1);
  });

  describe("reviewOpportunityAction", () => {
    const ACTION_ID = "00000000-0000-4000-8000-000000000099";
    const USER_ID = "00000000-0000-4000-8000-000000000002";

    it("approves proposed action and advances awaiting_human opportunity to action_ready", async () => {
      const mockClient = createMockSupabase();
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "awaiting_human",
        confidence: 0.95,
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "prepare_personalized_draft",
        status: "proposed",
        idempotency_key: "idemp-action-1",
      });

      const result = await reviewOpportunityAction(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        action_id: ACTION_ID,
        status: "approved",
        user_id: USER_ID,
      });

      expect(result.status).toBe("approved");
      expect(result.previous_status).toBe("proposed");
      expect(result.opportunity_state).toBe("action_ready");
      expect(result.event_emitted).toBe(true);

      const readyEvent = mockClient._tables.event_log.find(
        (ev) => ev.event_type === "opportunity.ready_for_action",
      );
      expect(readyEvent).toBeDefined();
      expect((readyEvent?.payload as Record<string, unknown>).action).toBe(
        "prepare_personalized_draft",
      );
    });

    it("rejects proposed action and dismisses the opportunity", async () => {
      const mockClient = createMockSupabase();
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "awaiting_human",
        confidence: 0.8,
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "prepare_personalized_draft",
        status: "proposed",
        idempotency_key: "idemp-action-2",
      });

      const result = await reviewOpportunityAction(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        action_id: ACTION_ID,
        status: "rejected",
        user_id: USER_ID,
        reason: "Fora do perfil de atendimento da agência",
      });

      expect(result.status).toBe("rejected");
      expect(result.opportunity_state).toBe("dismissed");
      expect(result.event_emitted).toBe(false);
    });

    it("does not approve a personalized draft after its evidence expires", async () => {
      const mockClient = createMockSupabase();
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "awaiting_human",
        confidence: 0.95,
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "prepare_personalized_draft",
        status: "proposed",
        idempotency_key: "idemp-action-stale",
        evidence_keys: ["e-stale"],
      });
      mockClient._tables.opportunity_evidence.push({
        id: "evidence-stale",
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        evidence_key: "e-stale",
        expires_at: "2026-09-19T15:00:00.000Z",
      });

      await expect(
        reviewOpportunityAction(asSupabaseClient(mockClient), {
          organization_id: ORGANIZATION_ID,
          action_id: ACTION_ID,
          status: "approved",
          user_id: USER_ID,
        }),
      ).rejects.toThrow("opportunity_evidence_stale_at_approval");
      expect(mockClient._tables.opportunity_actions[0]?.status).toBe("proposed");
    });

    it("handles idempotent replay when status is already approved", async () => {
      const mockClient = createMockSupabase();
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "action_ready",
        confidence: 0.95,
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "prepare_personalized_draft",
        status: "approved",
        idempotency_key: "idemp-action-3",
      });
      mockClient._tables.event_log.push({
        id: "66666666-6666-4666-8666-666666666666",
        organization_id: ORGANIZATION_ID,
        event_type: "opportunity.ready_for_action",
        entity_id: OPPORTUNITY_ID,
        metadata: { idempotency_key: `action-approved-${ACTION_ID}` },
      });

      const result = await reviewOpportunityAction(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        action_id: ACTION_ID,
        status: "approved",
        user_id: USER_ID,
      });

      expect(result.status).toBe("approved");
      expect(result.previous_status).toBe("approved");
      expect(result.event_emitted).toBe(false);
      expect(mockClient._tables.event_log).toHaveLength(1);
    });

    it("reconciles approval when the action was saved but its event was not", async () => {
      const mockClient = createMockSupabase();
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "action_ready",
        confidence: 0.95,
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "prepare_personalized_draft",
        status: "approved",
        idempotency_key: "idemp-action-4",
      });

      const result = await reviewOpportunityAction(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        action_id: ACTION_ID,
        status: "approved",
        user_id: USER_ID,
      });

      expect(result.event_emitted).toBe(true);
      expect(mockClient._tables.event_log).toHaveLength(1);
    });

    it("executes link_existing_lead action, inserting into crm_lead_activities and transitioning to action_ready", async () => {
      const mockClient = createMockSupabase();
      const LEAD_ID = "00000000-0000-4000-8000-000000000099";
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "awaiting_human",
        confidence: 0.85,
        display_name: "Empresa Parceira",
        domain: "empresaparceira.com.br",
        linked_lead_id: LEAD_ID,
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "link_existing_lead",
        status: "proposed",
        idempotency_key: "idemp-action-link",
      });

      const result = await reviewOpportunityAction(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        action_id: ACTION_ID,
        status: "approved",
        user_id: USER_ID,
      });

      expect(result.status).toBe("executed");
      expect(result.opportunity_state).toBe("action_ready");
      expect(result.event_emitted).toBe(true);

      // Verify activity in crm_lead_activities
      expect(mockClient._tables.crm_lead_activities).toHaveLength(1);
      const activity = mockClient._tables.crm_lead_activities[0];
      expect(activity?.lead_id).toBe(LEAD_ID);
      expect(activity?.source_module).toBe("opportunity_intelligence");
      expect(activity?.type).toBe("opportunity_linked");
    });
  });

  describe("linkOpportunityToLead", () => {
    it("creates crm_lead_activity and links opportunity deterministically", async () => {
      const mockClient = createMockSupabase();
      const LEAD_ID = "00000000-0000-4000-8000-000000000099";
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "awaiting_human",
        confidence: 0.9,
        display_name: "Padaria Alfa",
        domain: "padariaalfa.com.br",
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "link_existing_lead",
        status: "proposed",
        idempotency_key: "idemp-action-link-direct",
      });

      const result = await linkOpportunityToLead(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        lead_id: LEAD_ID,
        action_id: ACTION_ID,
        user_id: USER_ID,
      });

      expect(result.opportunity_id).toBe(OPPORTUNITY_ID);
      expect(result.lead_id).toBe(LEAD_ID);
      expect(result.previous_state).toBe("awaiting_human");
      expect(result.new_state).toBe("action_ready");
      expect(result.event_emitted).toBe(true);

      expect(mockClient._tables.crm_lead_activities).toHaveLength(1);
      expect(mockClient._tables.crm_lead_activities[0]?.type).toBe("opportunity_linked");
      expect(mockClient._tables.crm_lead_activities[0]?.source_module).toBe(
        "opportunity_intelligence",
      );

      // Verify record update
      const updatedRecord = mockClient._tables.opportunity_records.find(
        (r) => r.id === OPPORTUNITY_ID,
      );
      expect(updatedRecord?.linked_lead_id).toBe(LEAD_ID);
      expect(updatedRecord?.state).toBe("action_ready");

      // Verify action marked as executed
      const updatedAction = mockClient._tables.opportunity_actions.find((a) => a.id === ACTION_ID);
      expect(updatedAction?.status).toBe("executed");
    });

    it("rejects linking when opportunity is suppressed", async () => {
      const mockClient = createMockSupabase();
      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "suppressed",
        confidence: 0,
      });

      await expect(
        linkOpportunityToLead(asSupabaseClient(mockClient), {
          organization_id: ORGANIZATION_ID,
          opportunity_id: OPPORTUNITY_ID,
          lead_id: "00000000-0000-4000-8000-000000000099",
        }),
      ).rejects.toThrow("cannot_link_suppressed_opportunity");
    });

    it("conforms to Cometa's activity vocabulary and timeline contract", () => {
      const activityType: ActivityType = "opportunity_linked";
      expect(activityType).toBe("opportunity_linked");
      expect(ACTIVITY_LABELS.opportunity_linked).toBe("Oportunidade vinculada ao negócio");
    });

    it("handles replay/idempotency when crm_lead_activity already exists without duplicating rows", async () => {
      const mockClient = createMockSupabase();
      const LEAD_ID = "00000000-0000-4000-8000-000000000099";
      const activityIdempotencyKey = `opp-link-${OPPORTUNITY_ID}-${LEAD_ID}`;

      mockClient._tables.opportunity_records.push({
        id: OPPORTUNITY_ID,
        organization_id: ORGANIZATION_ID,
        state: "awaiting_human",
        confidence: 0.9,
        display_name: "Padaria Alfa",
        domain: "padariaalfa.com.br",
      });
      mockClient._tables.opportunity_actions.push({
        id: ACTION_ID,
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        action: "link_existing_lead",
        status: "proposed",
        idempotency_key: "idemp-action-link-direct",
      });

      // Simula execução anterior que persistiu a atividade antes de um crash
      mockClient._tables.crm_lead_activities.push({
        id: "existing-act-1",
        organization_id: ORGANIZATION_ID,
        lead_id: LEAD_ID,
        source_module: "opportunity_intelligence",
        source_id: OPPORTUNITY_ID,
        type: "opportunity_linked",
        metadata: { idempotency_key: activityIdempotencyKey },
      });

      const result = await linkOpportunityToLead(asSupabaseClient(mockClient), {
        organization_id: ORGANIZATION_ID,
        opportunity_id: OPPORTUNITY_ID,
        lead_id: LEAD_ID,
        action_id: ACTION_ID,
        user_id: USER_ID,
      });

      expect(result.opportunity_id).toBe(OPPORTUNITY_ID);
      expect(result.lead_id).toBe(LEAD_ID);
      expect(result.new_state).toBe("action_ready");

      // Invariante de idempotência da timeline: nenhuma linha extra é inserida
      expect(mockClient._tables.crm_lead_activities).toHaveLength(1);
      expect(mockClient._tables.crm_lead_activities[0]?.id).toBe("existing-act-1");
    });
  });

  describe("RPC 0244 Negative ACL & Cross-Tenant Guards", () => {
    it("rejects when caller lacks EXECUTE permission on persist_opportunity_pipeline_plan RPC", async () => {
      const positive = GOLDEN_OPPORTUNITY_FIXTURES[0]!;
      const assessment: OpportunityPipelineAssessment = {
        opportunity_id: OPPORTUNITY_ID,
        candidate: {
          identity: { display_name: "Mock Corp", domain: "https://mock.example" },
          identity_key: "domain:mock.example",
          source_id: "synthetic-source",
          external_id: "mock-1",
          collected_at: "2026-09-20T15:00:00.000Z",
          source_url: "https://mock.example",
          facts: {},
          duplicate_source_ids: [],
        },
        required_signal_keys: positive.input.required_signal_keys,
        signals: positive.input.signals,
        evidence: positive.input.evidence,
        strategy: positive.input.strategy,
        tenant_policy: positive.input.tenant_policy,
        linked_lead_id: null,
        existing_lead: "none",
        suppressed: false,
      };

      const plan = planOpportunityPipeline({
        trace_id: "00000000-0000-4000-8000-000000000091",
        schema_version: 1,
        organization_id: ORGANIZATION_ID,
        assessments: [assessment],
      });

      const mockClient = createMockSupabase();
      mockClient.rpc = vi.fn(async (functionName: string) => {
        if (functionName === "persist_opportunity_pipeline_plan") {
          return {
            data: null,
            error: {
              message: "permission denied for function persist_opportunity_pipeline_plan",
              code: "42501",
            } as never,
          };
        }
        return { data: "rpc-result", error: null };
      });

      await expect(
        persistOpportunityPipelinePlan(asSupabaseClient(mockClient), plan, [assessment]),
      ).rejects.toThrow(
        "opportunity_pipeline_persist_rpc_failed: permission denied for function persist_opportunity_pipeline_plan",
      );
    });

    it("rejects when cross-tenant access is attempted during RPC invocation", async () => {
      const positive = GOLDEN_OPPORTUNITY_FIXTURES[0]!;
      const foreignOrgId = "00000000-0000-4000-8000-999999999999";
      const assessment: OpportunityPipelineAssessment = {
        opportunity_id: OPPORTUNITY_ID,
        candidate: {
          identity: { display_name: "Mock Corp", domain: "https://mock.example" },
          identity_key: "domain:mock.example",
          source_id: "synthetic-source",
          external_id: "mock-1",
          collected_at: "2026-09-20T15:00:00.000Z",
          source_url: "https://mock.example",
          facts: {},
          duplicate_source_ids: [],
        },
        required_signal_keys: positive.input.required_signal_keys,
        signals: positive.input.signals,
        evidence: positive.input.evidence,
        strategy: positive.input.strategy,
        tenant_policy: positive.input.tenant_policy,
        linked_lead_id: null,
        existing_lead: "none",
        suppressed: false,
      };

      const plan = planOpportunityPipeline({
        trace_id: "00000000-0000-4000-8000-000000000092",
        schema_version: 1,
        organization_id: foreignOrgId,
        assessments: [assessment],
      });

      const mockClient = createMockSupabase();
      mockClient.rpc = vi.fn(async (functionName: string) => {
        if (functionName === "persist_opportunity_pipeline_plan") {
          return {
            data: null,
            error: {
              message: "caller_not_authorized_for_org",
              hint: "persist_opportunity_pipeline_plan: manager membership required",
            } as never,
          };
        }
        return { data: "rpc-result", error: null };
      });

      await expect(
        persistOpportunityPipelinePlan(asSupabaseClient(mockClient), plan, [assessment]),
      ).rejects.toThrow("opportunity_pipeline_persist_rpc_failed: caller_not_authorized_for_org");
    });
  });
});

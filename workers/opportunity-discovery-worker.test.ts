import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { runOpportunityDiscovery } from "@/workers/opportunity-discovery-worker";
import {
  createWebPresenceAdapter,
  type WebPresenceDataFetcher,
} from "@/lib/opportunity-intelligence/adapters/web-presence";
import type { SourceAdapter } from "@/lib/opportunity-intelligence/sources";

const ORG_ID = "00000000-0000-4000-8000-000000000001";

type MockRow = Record<string, unknown>;

function createMockSupabase(dataset: {
  crm_leads?: MockRow[];
  contacts?: MockRow[];
  opportunity_records?: MockRow[];
  opportunity_evidence?: MockRow[];
  opportunity_actions?: MockRow[];
  event_log?: MockRow[];
  api_audit_log?: MockRow[];
  simulateRecordPersistenceFailure?: boolean;
  simulateActionConflictOnUpsert?: boolean;
  failCandidateDomain?: string;
}) {
  const tables = {
    crm_leads: dataset.crm_leads ?? [],
    contacts: dataset.contacts ?? [],
    opportunity_records: dataset.opportunity_records ?? [],
    opportunity_evidence: dataset.opportunity_evidence ?? [],
    opportunity_actions: dataset.opportunity_actions ?? [],
    event_log: dataset.event_log ?? [],
    api_audit_log: dataset.api_audit_log ?? [],
  };

  let actionConflictPending = Boolean(dataset.simulateActionConflictOnUpsert);
  const client = {
    from: vi.fn((tableName: keyof typeof tables) => {
      const rows = tables[tableName] ?? [];
      const filters: Record<string, unknown> = {};

      const matches = (r: MockRow) => {
        for (const [k, v] of Object.entries(filters)) {
          if (k.startsWith("_ilike_")) {
            const actualCol = k.replace("_ilike_", "");
            const str = String(r[actualCol] ?? "");
            const rawPattern = String(v).replace(/%/g, "");
            if (!str.toLowerCase().includes(rawPattern.toLowerCase())) return false;
          } else if (k === "metadata->>idempotency_key") {
            const meta = r.metadata as Record<string, unknown> | undefined;
            if (meta?.idempotency_key !== v) return false;
          } else if (r[k] !== v) {
            return false;
          }
        }
        return true;
      };

      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val;
          return query;
        }),
        ilike: vi.fn((col: string, pattern: string) => {
          filters[`_ilike_${col}`] = pattern;
          return query;
        }),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => {
          if (tableName === "opportunity_records" && dataset.failCandidateDomain) {
            const identityKey = filters.identity_key;
            if (
              typeof identityKey === "string" &&
              identityKey.includes(dataset.failCandidateDomain)
            ) {
              throw new Error(
                `Timeout consulting candidate state for ${dataset.failCandidateDomain}`,
              );
            }
          }
          if (tableName === "opportunity_actions" && dataset.simulateActionConflictOnUpsert) {
            const existing = rows[0] ?? null;
            return { data: existing ? { ...existing } : null, error: null };
          }
          const match = rows.find(matches);
          return { data: match ? { ...match } : null, error: null };
        }),
        single: vi.fn(async () => {
          const match = rows.find(matches);
          return {
            data: match ? { ...match } : { id: "mock-id", state: "awaiting_human" },
            error: null,
          };
        }),
        upsert: vi.fn(
          (
            inputRows: MockRow | MockRow[],
            options?: { onConflict?: string; ignoreDuplicates?: boolean },
          ) => {
            if (dataset.simulateRecordPersistenceFailure && tableName === "opportunity_records") {
              return {
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: null,
                    error: new Error(
                      "PostgreSQL connection terminated during persistence transaction (57P01)",
                    ),
                  })),
                  maybeSingle: vi.fn(async () => ({
                    data: null,
                    error: new Error(
                      "PostgreSQL connection terminated during persistence transaction (57P01)",
                    ),
                  })),
                })),
              };
            }

            if (actionConflictPending && tableName === "opportunity_actions") {
              actionConflictPending = false;
              return {
                select: vi.fn(() => ({
                  single: vi.fn(async () => ({
                    data: null,
                    error: new Error(
                      "duplicate key value violates unique constraint 'opportunity_actions_organization_id_idempotency_key_key'",
                    ),
                  })),
                  maybeSingle: vi.fn(async () => ({
                    data: null,
                    error: new Error(
                      "duplicate key value violates unique constraint 'opportunity_actions_organization_id_idempotency_key_key'",
                    ),
                  })),
                })),
              };
            }

            const arr = Array.isArray(inputRows) ? inputRows : [inputRows];
            let lastSavedRow: MockRow | null = null;

            for (const r of arr) {
              let existingIdx = -1;
              if (tableName === "opportunity_records" && r.identity_key) {
                existingIdx = rows.findIndex(
                  (row) =>
                    row.organization_id === r.organization_id &&
                    row.identity_key === r.identity_key,
                );
              } else if (tableName === "opportunity_actions" && r.idempotency_key) {
                existingIdx = rows.findIndex(
                  (row) =>
                    row.organization_id === r.organization_id &&
                    row.idempotency_key === r.idempotency_key,
                );
              } else if (tableName === "opportunity_evidence" && r.evidence_key) {
                existingIdx = rows.findIndex(
                  (row) =>
                    row.organization_id === r.organization_id &&
                    row.opportunity_id === r.opportunity_id &&
                    row.evidence_key === r.evidence_key,
                );
              }

              if (existingIdx >= 0) {
                if (!options?.ignoreDuplicates) {
                  rows[existingIdx] = { ...rows[existingIdx], ...r };
                }
                lastSavedRow = rows[existingIdx]!;
              } else {
                const newRow = { ...r, id: r.id ?? `gen-${rows.length + 1}` };
                rows.push(newRow);
                lastSavedRow = newRow;
              }
            }

            const fallbackRow = lastSavedRow ?? { id: "saved-id", state: "awaiting_human" };
            return {
              select: vi.fn(() => ({
                single: vi.fn(async () => ({ data: { ...fallbackRow }, error: null })),
                maybeSingle: vi.fn(async () => ({ data: { ...fallbackRow }, error: null })),
              })),
            };
          },
        ),
        insert: vi.fn(async (inputRows: MockRow | MockRow[]) => {
          const arr = Array.isArray(inputRows) ? inputRows : [inputRows];
          for (const r of arr) {
            rows.push({ ...r, id: r.id ?? `gen-ins-${rows.length + 1}` });
          }
          return { data: arr, error: null };
        }),
        update: vi.fn((values: MockRow) => {
          const match = rows.find(matches);
          if (match) {
            Object.assign(match, values);
          }
          return query;
        }),
      };

      return query;
    }),
    rpc: vi.fn(async (functionName: string, args: Record<string, unknown>) => {
      if (functionName === "persist_opportunity_pipeline_plan") {
        if (dataset.simulateRecordPersistenceFailure) {
          return {
            data: null,
            error: new Error(
              "opportunity_record_upsert_failed: PostgreSQL connection terminated during persistence transaction (57P01)",
            ),
          };
        }

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
      return { data: "rpc-ok", error: null };
    }),
    _tables: tables,
  };

  return client as unknown as SupabaseClient & { _tables: typeof tables };
}

describe("opportunity-discovery-worker", () => {
  it("descobre candidatos, avalia e persiste plano no modo Copiloto", async () => {
    const mockDb = createMockSupabase({});
    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-101",
            name: "Padaria Central",
            domain: "padariacentral.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 42,
          },
        ];
      },
    };

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    expect(result.candidates_discovered).toBe(1);
    expect(result.opportunities_processed).toBe(1);
    expect(result.actions_proposed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(mockDb._tables.opportunity_records.length).toBe(1);
    expect(mockDb._tables.opportunity_evidence.length).toBeGreaterThan(0);
    expect(mockDb._tables.opportunity_actions.length).toBe(1);
    expect(mockDb._tables.api_audit_log.length).toBe(1);
    expect(mockDb._tables.event_log.length).toBeGreaterThan(0);
  });

  it("isola falhas por fonte sem abortar o processamento das fontes saudáveis", async () => {
    const mockDb = createMockSupabase({});

    const failingAdapter: SourceAdapter = {
      manifest: {
        source_id: "failing-api",
        source_kind: "official_api",
        terms_url: "https://example.com/terms",
        allow_automated_collection: true,
        rate_limit_per_minute: 10,
        supports_regions: ["SP"],
      },
      async discover() {
        throw new Error("API de terceiros indisponível (503 Service Unavailable)");
      },
    };

    const healthyFetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-202",
            name: "Mecânica Silva",
            domain: "mecanicasilva.com.br",
            has_mobile_friendly_site: true,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 80,
          },
        ];
      },
    };
    const healthyAdapter = createWebPresenceAdapter(healthyFetcher);

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      adapters: [failingAdapter, healthyAdapter],
    });

    // A fonte com erro gerou erro registrado, mas não derrubou a saudável
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.source_id).toBe("failing-api");
    expect(result.errors[0]?.code).toBe("source_failed");

    expect(result.candidates_discovered).toBe(1);
    expect(result.opportunities_processed).toBe(1);
  });

  it("isola falhas parciais por candidato na etapa de avaliação sem interromper o lote", async () => {
    const mockDb = createMockSupabase({
      failCandidateDomain: "clinica-com-falha.com.br",
    });

    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-failing-cand",
            name: "Clínica Com Falha",
            domain: "clinica-com-falha.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 40,
          },
          {
            id: "biz-healthy-cand",
            name: "Clínica Saudável",
            domain: "clinica-saudavel.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 60,
          },
        ];
      },
    };

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    // Ambos os candidatos foram descobertos
    expect(result.candidates_discovered).toBe(2);
    // Apenas a clínica saudável avançou para o plano e persistência
    expect(result.opportunities_processed).toBe(1);
    expect(result.actions_proposed).toBe(1);

    // O erro do candidato com falha foi isolado e registrado
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("candidate_assessment_failed");
    expect(result.errors[0]?.message).toContain("clinica-com-falha.com.br");

    // Persistência preservada para o candidato saudável
    expect(mockDb._tables.opportunity_records).toHaveLength(1);
    expect(mockDb._tables.opportunity_records[0]?.domain).toBe("clinica-saudavel.com.br");
  });

  it("respeita supressão terminal e não cria nova ação para empresa suprimida", async () => {
    const mockDb = createMockSupabase({
      opportunity_records: [
        {
          id: "opp-suppressed-1",
          organization_id: ORG_ID,
          identity_key: "domain:optoutempresa.com.br",
          state: "suppressed",
        },
      ],
    });

    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-303",
            name: "Empresa Com OptOut",
            domain: "optoutempresa.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: false,
            page_speed_score: 20,
          },
        ];
      },
    };

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    expect(result.candidates_discovered).toBe(1);
    expect(result.actions_proposed).toBe(0);
    // Estado suprimido preservado de forma terminal
    expect(mockDb._tables.opportunity_records[0]?.state).toBe("suppressed");
  });

  it("suporta replay idempotente reprocessando o mesmo lote sem duplicar registros, ações ou auditoria", async () => {
    const mockDb = createMockSupabase({});
    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-replay-404",
            name: "Auto Center Replay",
            domain: "autocenterreplay.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 35,
          },
        ];
      },
    };

    // 1ª Rodada de Descoberta
    const result1 = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    expect(result1.candidates_discovered).toBe(1);
    expect(result1.opportunities_processed).toBe(1);
    expect(result1.actions_proposed).toBe(1);
    expect(result1.errors).toHaveLength(0);
    expect(mockDb._tables.opportunity_records).toHaveLength(1);
    expect(mockDb._tables.opportunity_actions).toHaveLength(1);

    const firstRecordId = mockDb._tables.opportunity_records[0]?.id;
    const firstActionKey = mockDb._tables.opportunity_actions[0]?.idempotency_key;
    expect(firstRecordId).toBeDefined();
    expect(firstActionKey).toBeDefined();

    // 2ª Rodada (Replay imediato com mesmo lote e mesmo banco)
    const result2 = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    expect(result2.candidates_discovered).toBe(1);
    expect(result2.opportunities_processed).toBe(1);
    expect(result2.errors).toHaveLength(0);

    // Invariante de Idempotência: Contagem de registros e ações permanece exatamente 1
    expect(mockDb._tables.opportunity_records).toHaveLength(1);
    expect(mockDb._tables.opportunity_actions).toHaveLength(1);
    expect(mockDb._tables.opportunity_records[0]?.id).toBe(firstRecordId);
    expect(mockDb._tables.opportunity_actions[0]?.idempotency_key).toBe(firstActionKey);
  });

  it("recupera graciosamente de conflito parcial no persister quando inserção de ação gera colisão de chave única", async () => {
    // Cenário: A oportunidade já possui uma ação proposta no banco com a mesma chave de idempotência.
    // O banco simula colisão de chave única ao tentar inserir novamente.
    const expectedActionKey = `${ORG_ID}:web-presence-audit:biz-conflict-505:request_human_review`;
    const existingActionId = "action-pre-existing-999";

    const mockDb = createMockSupabase({
      opportunity_actions: [
        {
          id: existingActionId,
          organization_id: ORG_ID,
          idempotency_key: expectedActionKey,
          status: "proposed",
          action: "request_human_review",
        },
      ],
      simulateActionConflictOnUpsert: true,
    });

    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-conflict-505",
            name: "Auto Center Conflito",
            domain: "conflito-parcial.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 50,
          },
        ];
      },
    };

    // A execução não quebra: o persister captura o erro 'unique' e recupera a ação existente
    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    expect(result.candidates_discovered).toBe(1);
    expect(result.opportunities_processed).toBe(1);
    expect(result.actions_proposed).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("garante que falha crítica no persister propaga erro determinístico sem mascarar falha de banco", async () => {
    const mockDb = createMockSupabase({
      simulateRecordPersistenceFailure: true,
    });

    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-crash-606",
            name: "Clínica Crash Proof",
            domain: "clinicacrashproof.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 50,
          },
        ];
      },
    };

    // Erro de integridade no banco (57P01) é propagado com código descritivo
    await expect(
      runOpportunityDiscovery({
        client: mockDb,
        organization_id: ORG_ID,
        region: "SP",
        dataFetcher: fetcher,
      }),
    ).rejects.toThrow("opportunity_record_upsert_failed");
  });

  it("garante que o runner NÃO libera outbound nem autonomia, mantendo status 'proposed' e Copiloto forçado", async () => {
    const mockDb = createMockSupabase({});
    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-copilot-707",
            name: "Restaurante Prime Copilot",
            domain: "restauranteprime.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 95,
          },
        ];
      },
    };

    // Tentativa deliberada de desabilitar aprovação humana via tenant_policy
    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
      tenant_policy: {
        require_human_approval: false,
      },
    });

    expect(result.opportunities_processed).toBe(1);
    expect(result.actions_proposed).toBe(1);

    // Invariante inegociável: Nenhuma ação jamais é salva como 'approved' ou 'executed'
    expect(mockDb._tables.opportunity_actions.length).toBeGreaterThan(0);
    for (const action of mockDb._tables.opportunity_actions) {
      expect(action.status).toBe("proposed");
      expect(action.status).not.toBe("approved");
      expect(action.status).not.toBe("executed");
      expect(action.requires_human_approval).toBe(true);
      expect(action.executed_at).toBeUndefined();
      expect(action.approved_at).toBeUndefined();
    }
  });

  it("vincula candidato a lead existente no CRM sem criar duplicata em crm_leads", async () => {
    const existingLeadId = "00000000-0000-4000-8000-000000000999";
    const mockDb = createMockSupabase({
      crm_leads: [
        {
          id: existingLeadId,
          organization_id: ORG_ID,
          email: "comercial@restaurantesabor.com.br",
          status: "contacted",
        },
      ],
    });

    const fetcher: WebPresenceDataFetcher = {
      async fetchRecords() {
        return [
          {
            id: "biz-crm-808",
            name: "Restaurante Sabor",
            domain: "restaurantesabor.com.br",
            has_mobile_friendly_site: false,
            has_whatsapp_cta: false,
            ssl_valid: true,
            page_speed_score: 60,
          },
        ];
      },
    };

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: fetcher,
    });

    expect(result.candidates_discovered).toBe(1);
    expect(result.opportunities_processed).toBe(1);

    // Nenhuma nova linha foi inserida em crm_leads (deduplicação garantida)
    expect(mockDb._tables.crm_leads).toHaveLength(1);

    // O registro de oportunidade foi associado ao lead existente
    expect(mockDb._tables.opportunity_records[0]?.linked_lead_id).toBe(existingLeadId);
  });

  it("bloqueia a descoberta e registra quota_exceeded sem disparar fetch quando os tokens são insuficientes", async () => {
    const mockDb = createMockSupabase({});
    const fetchSpy = vi.fn(async () => [
      {
        id: "biz-quota-1",
        name: "Oficina Rápida",
        domain: "oficinarapida.com.br",
        has_mobile_friendly_site: false,
        has_whatsapp_cta: false,
        ssl_valid: true,
        page_speed_score: 50,
      },
    ]);

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: { fetchRecords: fetchSpy },
      quotaState: {
        tokens: 0,
        lastRefillAt: new Date().toISOString(),
      },
      quotaCost: 1,
      quotaConfig: {
        capacity: 10,
        refillRatePerMinute: 1,
      },
    });

    // Validou antes do fetch: fetchSpy JAMAIS foi chamado
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.candidates_discovered).toBe(0);
    expect(result.opportunities_processed).toBe(0);
    expect(result.blocked_source_ids).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("quota_exceeded");
    expect(result.quota?.allowed).toBe(false);
  });

  it("permite a execução e consome tokens da quota quando o saldo é suficiente", async () => {
    const mockDb = createMockSupabase({});
    const fetchSpy = vi.fn(async () => [
      {
        id: "biz-quota-2",
        name: "Padaria Doce",
        domain: "padariadoce.com.br",
        has_mobile_friendly_site: false,
        has_whatsapp_cta: false,
        ssl_valid: true,
        page_speed_score: 55,
      },
    ]);

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: { fetchRecords: fetchSpy },
      quotaState: {
        tokens: 10,
        lastRefillAt: new Date().toISOString(),
      },
      quotaCost: 1,
      quotaConfig: {
        capacity: 10,
        refillRatePerMinute: 2,
      },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.candidates_discovered).toBe(1);
    expect(result.opportunities_processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.quota?.allowed).toBe(true);
    expect(result.quota?.remainingTokens).toBe(9);
  });

  it("respeita quota preauthorized sem re-consumir tokens (evita dupla cobrança)", async () => {
    const mockDb = createMockSupabase({});
    const fetchSpy = vi.fn(async () => [
      {
        id: "biz-preauth-1",
        name: "Lanchonete Central",
        domain: "lanchonetecentral.com.br",
        has_mobile_friendly_site: false,
        has_whatsapp_cta: false,
        ssl_valid: true,
        page_speed_score: 70,
      },
    ]);

    const preauthorizedDecision = {
      allowed: true,
      remainingTokens: 42,
      retryAfterSeconds: 0,
      nextState: {
        tokens: 42,
        lastRefillAt: new Date().toISOString(),
      },
    };

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: { fetchRecords: fetchSpy },
      quota: { preauthorized: preauthorizedDecision },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.candidates_discovered).toBe(1);
    expect(result.opportunities_processed).toBe(1);
    expect(result.errors).toHaveLength(0);
    // Preservou o saldo pré-autorizado sem descontar novamente
    expect(result.quota?.remainingTokens).toBe(42);
  });

  it("bloqueia imediatamente quando quota preauthorized informa allowed: false", async () => {
    const mockDb = createMockSupabase({});
    const fetchSpy = vi.fn();

    const rejectedPreauth = {
      allowed: false,
      remainingTokens: 0,
      retryAfterSeconds: 45,
      nextState: {
        tokens: 0,
        lastRefillAt: new Date().toISOString(),
      },
    };

    const result = await runOpportunityDiscovery({
      client: mockDb,
      organization_id: ORG_ID,
      region: "SP",
      dataFetcher: { fetchRecords: fetchSpy },
      quota: { preauthorized: rejectedPreauth },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.candidates_discovered).toBe(0);
    expect(result.blocked_source_ids).toHaveLength(1);
    expect(result.errors[0]?.code).toBe("quota_exceeded");
    expect(result.quota?.allowed).toBe(false);
  });

  describe("Supressão Terminal via Contacts (is_blocked / is_anonymized)", () => {
    it("quando o telefone do candidato possui contato com is_blocked: true, preserva record suprimido e não cria ação", async () => {
      const mockDb = createMockSupabase({
        contacts: [
          {
            id: "contact-blocked-1",
            organization_id: ORG_ID,
            phone_number: "+5511999990001",
            is_blocked: true,
            is_anonymized: false,
          },
        ],
      });

      const fetcher: WebPresenceDataFetcher = {
        async fetchRecords() {
          return [
            {
              id: "biz-blocked-1",
              name: "Pizzaria Bloqueada",
              domain: "pizzariabloqueada.com.br",
              phone_e164: "+5511999990001",
              has_mobile_friendly_site: false,
              has_whatsapp_cta: false,
              ssl_valid: true,
              page_speed_score: 45,
            },
          ];
        },
      };

      const result = await runOpportunityDiscovery({
        client: mockDb,
        organization_id: ORG_ID,
        region: "SP",
        dataFetcher: fetcher,
      });

      // 1 candidato descoberto e processado
      expect(result.candidates_discovered).toBe(1);
      expect(result.opportunities_processed).toBe(1);
      // Nenhuma ação proposta (zero outbound)
      expect(result.actions_proposed).toBe(0);
      expect(result.errors).toHaveLength(0);

      // Record persistido no banco com estado terminal 'suppressed'
      const record = mockDb._tables.opportunity_records[0];
      expect(record).toBeDefined();
      expect(record?.state).toBe("suppressed");

      // Nenhuma ação criada na tabela de ações
      expect(mockDb._tables.opportunity_actions).toHaveLength(0);
    });

    it("quando o telefone do candidato possui contato com is_anonymized: true, preserva record suprimido e não cria ação", async () => {
      const mockDb = createMockSupabase({
        contacts: [
          {
            id: "contact-anonymized-1",
            organization_id: ORG_ID,
            phone_number: "+5511988880002",
            is_blocked: false,
            is_anonymized: true,
          },
        ],
      });

      const fetcher: WebPresenceDataFetcher = {
        async fetchRecords() {
          return [
            {
              id: "biz-anonymized-1",
              name: "Auto Peças Anonimizada",
              domain: "autopecasanonimizada.com.br",
              phone_e164: "+5511988880002",
              has_mobile_friendly_site: false,
              has_whatsapp_cta: false,
              ssl_valid: true,
              page_speed_score: 55,
            },
          ];
        },
      };

      const result = await runOpportunityDiscovery({
        client: mockDb,
        organization_id: ORG_ID,
        region: "SP",
        dataFetcher: fetcher,
      });

      expect(result.candidates_discovered).toBe(1);
      expect(result.opportunities_processed).toBe(1);
      expect(result.actions_proposed).toBe(0);
      expect(result.errors).toHaveLength(0);

      const record = mockDb._tables.opportunity_records[0];
      expect(record?.state).toBe("suppressed");
      expect(mockDb._tables.opportunity_actions).toHaveLength(0);
    });

    it("quando o contato existe mas não está bloqueado nem anonimizado, prossegue normalmente e propõe ação", async () => {
      const mockDb = createMockSupabase({
        contacts: [
          {
            id: "contact-active-1",
            organization_id: ORG_ID,
            phone_number: "+5511977770003",
            is_blocked: false,
            is_anonymized: false,
          },
        ],
      });

      const fetcher: WebPresenceDataFetcher = {
        async fetchRecords() {
          return [
            {
              id: "biz-active-1",
              name: "Clinica Ativa",
              domain: "clinicaativa.com.br",
              phone_e164: "+5511977770003",
              has_mobile_friendly_site: false,
              has_whatsapp_cta: false,
              ssl_valid: true,
              page_speed_score: 55,
            },
          ];
        },
      };

      const result = await runOpportunityDiscovery({
        client: mockDb,
        organization_id: ORG_ID,
        region: "SP",
        dataFetcher: fetcher,
      });

      expect(result.candidates_discovered).toBe(1);
      expect(result.opportunities_processed).toBe(1);
      // Propõe ação normalmente
      expect(result.actions_proposed).toBe(1);
      expect(result.errors).toHaveLength(0);

      const record = mockDb._tables.opportunity_records[0];
      expect(record?.state).toBe("awaiting_human");
      expect(mockDb._tables.opportunity_actions).toHaveLength(1);
    });
  });
});

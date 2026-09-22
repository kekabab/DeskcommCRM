import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";
import { runOpportunityDiscovery } from "@/workers/opportunity-discovery-worker";
import { GET, POST } from "./route";

vi.mock("@/lib/env", () => ({
  env: {
    INTERNAL_CRON_SECRET: "test-cron-secret",
    INTERNAL_SECRET: "test-internal-secret",
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(),
}));

vi.mock("@/workers/opportunity-discovery-worker", () => ({
  runOpportunityDiscovery: vi.fn(),
}));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const SOURCE_CONFIG_ID = "11111111-1111-4111-8111-111111111111";

type MockRow = Record<string, unknown>;

function createMockAdmin(dataset: {
  configs?: MockRow[];
  runs?: MockRow[];
  simulateLockConflict?: boolean;
  rpcMock?: (
    fnName: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>;
  quotaAllowed?: boolean;
  quotaTokens?: number;
  quotaRetryAfterSeconds?: number;
  quotaRpcError?: { message: string } | null;
}) {
  const tables = {
    opportunity_source_configs: dataset.configs ?? [
      {
        id: SOURCE_CONFIG_ID,
        organization_id: ORG_ID,
        source_id: "open-business-feed",
        source_kind: "open_data",
        feed_url: "https://example.com/feed.json",
        terms_url: "https://example.com/terms",
        regions: ["SP"],
        niche: "servicos_digitais",
        offer_key: "otimizacao_conversao_local",
        rate_limit_per_minute: 30,
        max_records_per_run: 50,
        is_active: true,
      },
    ],
    opportunity_discovery_runs: dataset.runs ?? [],
    api_audit_log: [] as MockRow[],
  };

  const client = {
    rpc: vi.fn(async (fnName: string, args: Record<string, unknown>) => {
      if (dataset.rpcMock) {
        return dataset.rpcMock(fnName, args);
      }
      if (dataset.quotaRpcError) {
        return { data: null, error: dataset.quotaRpcError };
      }
      if (fnName === "consume_opportunity_source_quota") {
        const allowed = dataset.quotaAllowed ?? true;
        const tokens = dataset.quotaTokens ?? (allowed ? 29 : 0);
        const retryAfter = dataset.quotaRetryAfterSeconds ?? (allowed ? 0 : 60);
        return {
          data: {
            allowed,
            tokens_remaining: tokens,
            cost: Number(args?.p_cost ?? 1.0),
            retry_after_seconds: retryAfter,
            capacity: Number(args?.p_capacity ?? 30.0),
            refill_rate_per_minute: Number(args?.p_refill_rate_per_minute ?? 30.0),
            last_refill_at: new Date().toISOString(),
          },
          error: null,
        };
      }
      return { data: null, error: null };
    }),
    from: vi.fn((tableName: keyof typeof tables) => {
      const rows = tables[tableName] ?? [];
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val;
          return query;
        }),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => {
          return { data: rows[0] ? { ...rows[0] } : null, error: null };
        }),
        single: vi.fn(async () => {
          return { data: rows[0] ? { ...rows[0] } : null, error: null };
        }),
        upsert: vi.fn(
          (inputRow: MockRow, options?: { onConflict?: string; ignoreDuplicates?: boolean }) => {
            if (dataset.simulateLockConflict && tableName === "opportunity_discovery_runs") {
              // Em concorrência, o PostgreSQL com ignoreDuplicates não insere e não retorna id
              return {
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              };
            }

            const existingIdx = rows.findIndex((r) => {
              if (tableName === "opportunity_discovery_runs") {
                return (
                  r.organization_id === inputRow.organization_id &&
                  r.source_id === inputRow.source_id &&
                  r.window_key === inputRow.window_key
                );
              }
              return false;
            });

            if (existingIdx >= 0 && options?.ignoreDuplicates) {
              return {
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({ data: null, error: null })),
                })),
              };
            }

            const saved = { ...inputRow, id: inputRow.id ?? `run-${rows.length + 1}` };
            rows.push(saved);
            return {
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({ data: { id: saved.id }, error: null })),
              })),
            };
          },
        ),
        insert: vi.fn(async (inputRow: MockRow) => {
          rows.push(inputRow);
          return { error: null };
        }),
        update: vi.fn((updateValues: MockRow) => {
          return {
            eq: vi.fn((col: string, val: unknown) => {
              filters[col] = val;
              return {
                eq: vi.fn((col2: string, val2: unknown) => {
                  filters[col2] = val2;
                  const match = rows.find((r) => r[col] === val && r[col2] === val2);
                  if (match) {
                    Object.assign(match, updateValues);
                  }
                  return query;
                }),
              };
            }),
          };
        }),
        then: (resolve: (val: { data: MockRow[]; error: null }) => void) => {
          resolve({ data: rows, error: null });
        },
      };

      return query;
    }),
    _tables: tables,
  };

  return client;
}

function makeRequest(authHeader?: string, method = "POST"): NextRequest {
  const headers = new Headers();
  if (authHeader) headers.set("authorization", authHeader);
  return new NextRequest("http://localhost:3000/api/v1/cron/opportunity-discovery", {
    method,
    headers,
  });
}

describe("Cron: /api/v1/cron/opportunity-discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Autenticação e Segredo do Cron", () => {
    it("retorna 403 Forbidden quando chamada sem cabeçalho de autorização", async () => {
      const res = await POST(makeRequest());
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("forbidden");
    });

    it("retorna 403 Forbidden quando fornecido token incorreto", async () => {
      const res = await POST(makeRequest("Bearer token-invalido"));
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("forbidden");
    });

    it("aceita INTERNAL_CRON_SECRET válido e executa", async () => {
      const mockAdmin = createMockAdmin({});
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);
      vi.mocked(runOpportunityDiscovery).mockResolvedValue({
        trace_id: "trace-cron-1",
        organization_id: ORG_ID,
        attempted_source_ids: ["open-business-feed"],
        blocked_source_ids: [],
        candidates_discovered: 3,
        opportunities_processed: 2,
        actions_proposed: 2,
        errors: [],
      });

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.sources_attempted).toBe(1);
      expect(json.data.sources_skipped).toBe(0);
      expect(json.data.outbound).toBe("blocked");
    });

    it("aceita INTERNAL_SECRET válido via GET", async () => {
      const mockAdmin = createMockAdmin({});
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);
      vi.mocked(runOpportunityDiscovery).mockResolvedValue({
        trace_id: "trace-cron-2",
        organization_id: ORG_ID,
        attempted_source_ids: ["open-business-feed"],
        blocked_source_ids: [],
        candidates_discovered: 1,
        opportunities_processed: 1,
        actions_proposed: 1,
        errors: [],
      });

      const res = await GET(makeRequest("Bearer test-internal-secret", "GET"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.sources_attempted).toBe(1);
      expect(json.data.outbound).toBe("blocked");
    });
  });

  describe("Concorrência e Locks Horários (window_key)", () => {
    it("isola execuções concorrentes: a segunda chamada salta o lote sem duplicar processamento", async () => {
      // 1ª Execução obtém o lock de execução
      const mockAdmin1 = createMockAdmin({});
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin1 as never);
      vi.mocked(runOpportunityDiscovery).mockResolvedValue({
        trace_id: "trace-lock-1",
        organization_id: ORG_ID,
        attempted_source_ids: ["open-business-feed"],
        blocked_source_ids: [],
        candidates_discovered: 5,
        opportunities_processed: 5,
        actions_proposed: 5,
        errors: [],
      });

      const res1 = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res1.status).toBe(200);
      const json1 = await res1.json();
      expect(json1.data.sources_attempted).toBe(1);
      expect(json1.data.sources_skipped).toBe(0);
      expect(runOpportunityDiscovery).toHaveBeenCalledTimes(1);

      // 2ª Execução concorrente na mesma janela: colisão no lock (claim?.id nulo)
      const mockAdmin2 = createMockAdmin({ simulateLockConflict: true });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin2 as never);

      const res2 = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res2.status).toBe(200);
      const json2 = await res2.json();

      // Invariante de Concorrência: A segunda chamada é pulada sem reprocessar candidatos
      expect(json2.data.sources_attempted).toBe(0);
      expect(json2.data.sources_skipped).toBe(1);
      // Nenhuma chamada extra ao worker
      expect(runOpportunityDiscovery).toHaveBeenCalledTimes(1);
      // Nenhuma chamada de quota na segunda execução bloqueada pelo lock horário
      expect(mockAdmin2.rpc).not.toHaveBeenCalled();
      expect(mockAdmin1.rpc).toHaveBeenCalledWith("consume_opportunity_source_quota", {
        p_organization_id: ORG_ID,
        p_source_id: "open-business-feed",
        p_cost: 1,
        p_capacity: 30,
        p_refill_rate_per_minute: 30,
      });
    });

    it("permite reprocessamento (replay) limpo em janela horária posterior", async () => {
      const mockAdmin = createMockAdmin({});
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);
      vi.mocked(runOpportunityDiscovery).mockResolvedValue({
        trace_id: "trace-replay-1",
        organization_id: ORG_ID,
        attempted_source_ids: ["open-business-feed"],
        blocked_source_ids: [],
        candidates_discovered: 2,
        opportunities_processed: 2,
        actions_proposed: 2,
        errors: [],
      });

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.sources_attempted).toBe(1);
      expect(json.data.candidates_seen).toBe(2);
      expect(json.data.opportunities_created).toBe(2);
      expect(json.data.outbound).toBe("blocked");
      expect(mockAdmin.rpc).toHaveBeenCalledTimes(1);
    });
  });

  describe("Blindagem de Outbound e Tratamento de Erros", () => {
    it("registra erro da fonte no log de runs sem propagar 500 para o chamador do cron", async () => {
      const mockAdmin = createMockAdmin({});
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);
      vi.mocked(runOpportunityDiscovery).mockRejectedValue(
        new Error("Feed endpoint DNS resolution timeout (EAI_AGAIN)"),
      );

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.errors).toHaveLength(1);
      expect(json.data.errors[0].message).toContain("DNS resolution timeout");
      expect(json.data.outbound).toBe("blocked");
    });

    it("garante que o retorno do cron sempre confirma outbound: 'blocked'", async () => {
      const mockAdmin = createMockAdmin({ configs: [] });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.outbound).toBe("blocked");
      expect(json.data.sources_attempted).toBe(0);
      expect(json.data.sources_skipped).toBe(0);
    });
  });

  describe("Validação Atômica de Quota (consume_opportunity_source_quota RPC) antes do fetch", () => {
    it("quando a quota está esgotada pela RPC, não invoca o worker e registra quota_exceeded no ledger", async () => {
      const mockAdmin = createMockAdmin({
        quotaAllowed: false,
        quotaTokens: 0,
        quotaRetryAfterSeconds: 45,
      });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();

      // RPC é chamada com os parâmetros esperados da fonte
      expect(mockAdmin.rpc).toHaveBeenCalledWith("consume_opportunity_source_quota", {
        p_organization_id: ORG_ID,
        p_source_id: "open-business-feed",
        p_cost: 1,
        p_capacity: 30,
        p_refill_rate_per_minute: 30,
      });

      // Worker NÃO é chamado (fetch bloqueado antes de encostar na rede)
      expect(runOpportunityDiscovery).not.toHaveBeenCalled();

      // Erro explicável de quota retornado na resposta
      expect(json.data.errors).toHaveLength(1);
      expect(json.data.errors[0].code).toBe("quota_exceeded");
      expect(json.data.errors[0].message).toContain(
        "Tenant quota exceeded for source 'open-business-feed'",
      );
      expect(json.data.errors[0].message).toContain("retry in 45s");
      expect(json.data.outbound).toBe("blocked");

      // Ledger (opportunity_discovery_runs) atualizado com status failed e erro quota_exceeded
      const run = mockAdmin._tables.opportunity_discovery_runs[0] as
        | { status?: string; errors?: Array<{ code?: string; retry_after_seconds?: number }> }
        | undefined;
      expect(run?.status).toBe("failed");
      expect(run?.errors?.[0]?.code).toBe("quota_exceeded");
      expect(run?.errors?.[0]?.retry_after_seconds).toBe(45);

      // Source config atualizado com last_error
      const config = mockAdmin._tables.opportunity_source_configs[0];
      expect(config?.last_error).toContain("Tenant quota exceeded");
    });

    it("quando a quota é suficiente, repassa preauthorized para o worker e executa varredura com sucesso", async () => {
      const mockAdmin = createMockAdmin({
        quotaAllowed: true,
        quotaTokens: 29,
        quotaRetryAfterSeconds: 0,
      });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);
      vi.mocked(runOpportunityDiscovery).mockResolvedValue({
        trace_id: "trace-quota-ok",
        organization_id: ORG_ID,
        attempted_source_ids: ["open-business-feed"],
        blocked_source_ids: [],
        candidates_discovered: 3,
        opportunities_processed: 2,
        actions_proposed: 2,
        errors: [],
      });

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();

      // Confirma chamada única à RPC
      expect(mockAdmin.rpc).toHaveBeenCalledWith("consume_opportunity_source_quota", {
        p_organization_id: ORG_ID,
        p_source_id: "open-business-feed",
        p_cost: 1,
        p_capacity: 30,
        p_refill_rate_per_minute: 30,
      });

      // Confirma repasse explícito de quota preauthorized mapeada para o worker
      expect(runOpportunityDiscovery).toHaveBeenCalledTimes(1);
      const workerArgs = vi.mocked(runOpportunityDiscovery).mock.calls[0]?.[0];
      expect(workerArgs).toBeDefined();
      expect(workerArgs!.quota).toEqual({
        preauthorized: {
          allowed: true,
          remainingTokens: 29,
          retryAfterSeconds: 0,
          nextState: expect.objectContaining({
            tokens: 29,
          }),
        },
      });

      expect(json.data.candidates_seen).toBe(3);
      expect(json.data.opportunities_created).toBe(2);
      expect(json.data.errors).toHaveLength(0);
      expect(json.data.outbound).toBe("blocked");

      // Ledger de runs marcado com succeeded
      const run = mockAdmin._tables.opportunity_discovery_runs[0] as
        { status?: string; candidates_seen?: number; opportunities_created?: number } | undefined;
      expect(run?.status).toBe("succeeded");
      expect(run?.candidates_seen).toBe(3);
      expect(run?.opportunities_created).toBe(2);
    });

    it("resiliência a falhas na RPC: erro transacional no banco registra quota_rpc_error sem chamar worker", async () => {
      const mockAdmin = createMockAdmin({
        quotaRpcError: { message: "opportunity_quota_cross_tenant_access_denied" },
      });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin as never);

      const res = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res.status).toBe(200);
      const json = await res.json();

      // Worker NÃO é chamado se a validação de quota falhar na camada transacional
      expect(runOpportunityDiscovery).not.toHaveBeenCalled();

      // Erro registrado de forma explicável sem derrubar o processo cron
      expect(json.data.errors).toHaveLength(1);
      expect(json.data.errors[0].message).toContain(
        "Quota RPC failed for source 'open-business-feed'",
      );
      expect(json.data.outbound).toBe("blocked");

      // Ledger atualizado com falha explicável de quota_rpc_error
      const run = mockAdmin._tables.opportunity_discovery_runs[0] as
        { status?: string; errors?: Array<{ code?: string }> } | undefined;
      expect(run?.status).toBe("failed");
      expect(run?.errors?.[0]?.code).toBe("quota_rpc_error");

      // Source config atualizado com last_error
      const config = mockAdmin._tables.opportunity_source_configs[0];
      expect(config?.last_error).toContain("Quota RPC failed");
    });

    it("replay de quota após refill: rodada rejeitada recupera em execução posterior quando tokens são restaurados", async () => {
      // 1ª Rodada: Quota esgotada
      const mockAdmin1 = createMockAdmin({
        quotaAllowed: false,
        quotaTokens: 0,
        quotaRetryAfterSeconds: 60,
      });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin1 as never);

      const res1 = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res1.status).toBe(200);
      expect(runOpportunityDiscovery).not.toHaveBeenCalled();

      // 2ª Rodada (Replay após intervalo de refill): RPC atômica retorna tokens restaurados
      const mockAdmin2 = createMockAdmin({
        quotaAllowed: true,
        quotaTokens: 15,
        quotaRetryAfterSeconds: 0,
      });
      vi.mocked(createAdminClient).mockReturnValue(mockAdmin2 as never);
      vi.mocked(runOpportunityDiscovery).mockResolvedValue({
        trace_id: "trace-refill-replay",
        organization_id: ORG_ID,
        attempted_source_ids: ["open-business-feed"],
        blocked_source_ids: [],
        candidates_discovered: 1,
        opportunities_processed: 1,
        actions_proposed: 1,
        errors: [],
      });

      const res2 = await POST(makeRequest("Bearer test-cron-secret"));
      expect(res2.status).toBe(200);
      const json2 = await res2.json();

      expect(runOpportunityDiscovery).toHaveBeenCalledTimes(1);
      expect(json2.data.candidates_seen).toBe(1);
      expect(json2.data.errors).toHaveLength(0);
      expect(json2.data.outbound).toBe("blocked");
    });
  });
});

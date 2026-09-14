/**
 * Testes unitários para finishOnboarding:
 * - Atualização de interface_settings no vínculo user_organizations
 * - Idempotência da conclusão do onboarding
 * - Validação dos destinos AtendePro contra NAV_CATALOG
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

interface MockQuery {
  table: string;
  op: "select" | "update" | "insert";
  payload: Record<string, unknown> | null;
  filters: Record<string, unknown>;
}

const queries: MockQuery[] = [];
const audits: Array<{ action: string; metadata?: Record<string, unknown> }> = [];
const redirects: string[] = [];

let mockOrgState: { onboarded_at: string | null } = { onboarded_at: null };
let mockMemberUpdateError: string | null = null;
let mockOrgUpdateError: string | null = null;

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    const err = new Error(`NEXT_REDIRECT: ${url}`);
    (err as { digest?: string }).digest = `NEXT_REDIRECT;replace;${url}`;
    throw err;
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async (entry: { action: string; metadata?: Record<string, unknown> }) => {
    audits.push(entry);
  }),
}));

vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(async () => ({
    id: USER_ID,
    email: "atendepro@teste.local",
    full_name: "Operador Teste",
  })),
  resolveActiveOrg: vi.fn(async () => ({
    orgId: ORG_ID,
    name: "Clínica Teste",
    role: "admin",
  })),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: MockQuery = { table, op: "select", payload: null, filters: {} };
      const builder = {
        select: () => builder,
        insert: (payload: Record<string, unknown>) => {
          q.op = "insert";
          q.payload = payload;
          queries.push(q);
          return Promise.resolve({ data: payload, error: null });
        },
        update: (payload: Record<string, unknown>) => {
          q.op = "update";
          q.payload = payload;
          queries.push(q);
          if (table === "user_organizations" && mockMemberUpdateError) {
            return builder;
          }
          if (table === "organizations" && mockOrgUpdateError) {
            return builder;
          }
          return builder;
        },
        eq: (col: string, val: unknown) => {
          q.filters[col] = val;
          return builder;
        },
        is: (col: string, val: unknown) => {
          q.filters[col] = val;
          return builder;
        },
        maybeSingle: () => {
          queries.push(q);
          if (table === "organizations") {
            return Promise.resolve({
              data: { onboarded_at: mockOrgState.onboarded_at },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (res: { data: unknown; error: { message: string } | null }) => void) => {
          if (table === "user_organizations" && mockMemberUpdateError) {
            resolve({ data: null, error: { message: mockMemberUpdateError } });
            return;
          }
          if (table === "organizations" && mockOrgUpdateError) {
            resolve({ data: null, error: { message: mockOrgUpdateError } });
            return;
          }
          resolve({ data: q.payload, error: null });
        },
      };
      return builder;
    },
  }),
}));

import { finishOnboarding } from "@/app/actions/onboarding/finishOnboarding";
import { ATENDEPRO_DEFAULT_INTERFACE } from "@/lib/atendepro/interface-preset";
import { NAV_CATALOG } from "@/lib/navigation/catalogo";

describe("finishOnboarding com preset AtendePro por vínculo", () => {
  beforeEach(() => {
    queries.length = 0;
    audits.length = 0;
    redirects.length = 0;
    mockOrgState = { onboarded_at: null };
    mockMemberUpdateError = null;
    mockOrgUpdateError = null;
  });

  it("ATENDEPRO_DEFAULT_INTERFACE define preset simplificada e apenas destinos reais do NAV_CATALOG", () => {
    expect(ATENDEPRO_DEFAULT_INTERFACE.preset).toBe("simplificada");
    expect(ATENDEPRO_DEFAULT_INTERFACE.destinos).toBeDefined();

    const catalogoHrefs = new Set(NAV_CATALOG.map((item) => item.href));
    const destinos = ATENDEPRO_DEFAULT_INTERFACE.destinos!;

    // Todos os destinos declarados devem existir no NAV_CATALOG
    for (const d of destinos) {
      expect(catalogoHrefs.has(d), `Destino ${d} deve constar no NAV_CATALOG`).toBe(true);
    }

    // Deve conter os 9 destinos requeridos pelo AtendePro
    expect(destinos).toContain("/app/inbox");
    expect(destinos).toContain("/app/agenda");
    expect(destinos).toContain("/app/kanban");
    expect(destinos).toContain("/app/contacts");
    expect(destinos).toContain("/app/tasks");
    expect(destinos).toContain("/app/connections");
    expect(destinos).toContain("/app/ai/agents");
    expect(destinos).toContain("/app/products");
    expect(destinos).toContain("/app/settings/tenant/agenda");
  });

  it("grava interface_settings no vínculo user_organizations do usuário da sessão e carimba onboarded_at", async () => {
    await expect(finishOnboarding()).rejects.toThrow("NEXT_REDIRECT: /app/inbox");

    // Verifica que user_organizations foi atualizado com o preset AtendePro
    const memberUpdate = queries.find((q) => q.table === "user_organizations" && q.op === "update");
    expect(memberUpdate).toBeDefined();
    expect(memberUpdate!.filters.organization_id).toBe(ORG_ID);
    expect(memberUpdate!.filters.user_id).toBe(USER_ID);
    expect(memberUpdate!.payload).toEqual({
      interface_settings: ATENDEPRO_DEFAULT_INTERFACE,
    });

    // Verifica que organizations teve onboarded_at carimbado
    const orgUpdate = queries.find((q) => q.table === "organizations" && q.op === "update");
    expect(orgUpdate).toBeDefined();
    expect(orgUpdate!.filters.id).toBe(ORG_ID);
    expect(orgUpdate!.filters.onboarded_at).toBeNull();
    expect(orgUpdate!.payload?.onboarded_at).toBeDefined();

    // Verifica emissão de evento e auditoria
    const eventInsert = queries.find((q) => q.table === "event_log" && q.op === "insert");
    expect(eventInsert).toBeDefined();
    expect(eventInsert!.payload?.event_type).toBe("tenant.onboarded");

    expect(audits.some((a) => a.action === "onboarding.completed")).toBe(true);
    expect(audits.some((a) => a.action === "tenant.onboarded")).toBe(true);
    expect(redirects).toEqual(["/app/inbox"]);
  });

  it("idempotência: quando organização já concluiu onboarding, não regrava vínculo nem duplica eventos", async () => {
    mockOrgState.onboarded_at = "2026-09-01T12:00:00.000Z";

    await expect(finishOnboarding()).rejects.toThrow("NEXT_REDIRECT: /app/inbox");

    // Nenhuma atualização deve ser disparada
    const updates = queries.filter((q) => q.op === "update");
    expect(updates).toHaveLength(0);

    const inserts = queries.filter((q) => q.op === "insert");
    expect(inserts).toHaveLength(0);

    expect(audits).toHaveLength(0);
    expect(redirects).toEqual(["/app/inbox"]);
  });

  it("tratamento de erro: falha ao atualizar user_organizations interrompe o fluxo e não marca onboarded_at", async () => {
    mockMemberUpdateError = "connection timeout";

    const res = await finishOnboarding();

    expect(res).toEqual({
      ok: false,
      error: "db_error",
      details: "connection timeout",
    });

    // organizations NÃO deve ter sido carimbada
    const orgUpdate = queries.find((q) => q.table === "organizations" && q.op === "update");
    expect(orgUpdate).toBeUndefined();

    // Nenhum evento ou auditoria emitido
    expect(queries.filter((q) => q.table === "event_log")).toHaveLength(0);
    expect(audits).toHaveLength(0);
    expect(redirects).toHaveLength(0);
  });
});

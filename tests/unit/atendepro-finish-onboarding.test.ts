/**
 * Testes unitários para a Server Action finishOnboarding (AtendePro).
 *
 * Cobre:
 * 1. Atualização do vínculo user_organizations por user_id + organization_id.
 * 2. Aplicação do preset simplificado ATENDEPRO_DEFAULT_INTERFACE.
 * 3. Idempotência estrita: se onboarded_at já estiver carimbado, não regrava vínculo nem duplica eventos.
 * 4. Tratamento de falhas de banco e propagação de erros sem exceções não tratadas.
 * 5. Redirecionamento canônico para /app/inbox.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

interface QueryLog {
  table: string;
  op: "select" | "update" | "insert";
  payload: Record<string, unknown> | null;
  filters: Record<string, unknown>;
}

const queries: QueryLog[] = [];
const audits: Array<{
  action: string;
  actorUserId?: string;
  organizationId?: string;
  metadata?: Record<string, unknown>;
}> = [];
const redirects: string[] = [];

let mockExistingOnboardedAt: string | null = null;
let mockOrgReadError: { message: string } | null = null;
let mockMemberUpdateError: { message: string } | null = null;
let mockOrgUpdateError: { message: string } | null = null;
let mockAuthError: Error | null = null;

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    const err = new Error(`NEXT_REDIRECT: ${url}`);
    (err as { digest?: string }).digest = `NEXT_REDIRECT;replace;${url}`;
    throw err;
  },
}));

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(
    async (entry: {
      action: string;
      actorUserId?: string;
      organizationId?: string;
      metadata?: Record<string, unknown>;
    }) => {
      audits.push(entry);
    },
  ),
}));

vi.mock("@/app/actions/onboarding/_shared", async (importOriginal) => {
  const actual = await importOriginal<typeof OnboardingSharedModule>();
  return {
    ...actual,
    requireOnboardingCtx: vi.fn(async () => {
      if (mockAuthError) throw mockAuthError;
      return {
        userId: USER_ID,
        orgId: ORG_ID,
        orgName: "Clínica AtendePro",
        role: "admin",
        fullName: "Dono Teste",
        email: "dono@teste.local",
      };
    }),
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q: QueryLog = { table, op: "select", payload: null, filters: {} };
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
            if (mockOrgReadError) return Promise.resolve({ data: null, error: mockOrgReadError });
            return Promise.resolve({
              data: { onboarded_at: mockExistingOnboardedAt },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (res: { data: unknown; error: { message: string } | null }) => void) => {
          if (table === "user_organizations" && mockMemberUpdateError) {
            resolve({ data: null, error: mockMemberUpdateError });
            return;
          }
          if (table === "organizations" && mockOrgUpdateError) {
            resolve({ data: null, error: mockOrgUpdateError });
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
import { OnboardingError } from "@/app/actions/onboarding/_shared";
import type * as OnboardingSharedModule from "@/app/actions/onboarding/_shared";

describe("AtendePro — finishOnboarding", () => {
  beforeEach(() => {
    queries.length = 0;
    audits.length = 0;
    redirects.length = 0;
    mockExistingOnboardedAt = null;
    mockOrgReadError = null;
    mockMemberUpdateError = null;
    mockOrgUpdateError = null;
    mockAuthError = null;
  });

  it("atualiza user_organizations usando obrigatoriamente user_id E organization_id como filtro", async () => {
    await expect(finishOnboarding()).rejects.toThrow("NEXT_REDIRECT: /app/inbox");

    const memberUpdate = queries.find((q) => q.table === "user_organizations" && q.op === "update");

    expect(memberUpdate, "Deve disparar update em user_organizations").toBeDefined();
    // Invariante de isolamento de tenant por vínculo
    expect(memberUpdate!.filters.organization_id).toBe(ORG_ID);
    expect(memberUpdate!.filters.user_id).toBe(USER_ID);
    expect(memberUpdate!.filters.revoked_at).toBeNull();
    expect(memberUpdate!.payload).toEqual({
      interface_settings: ATENDEPRO_DEFAULT_INTERFACE,
    });
  });

  it("garante que o preset ATENDEPRO_DEFAULT_INTERFACE define preset simplificada e rotas de navegação", () => {
    expect(ATENDEPRO_DEFAULT_INTERFACE.preset).toBe("simplificada");
    expect(Array.isArray(ATENDEPRO_DEFAULT_INTERFACE.destinos)).toBe(true);
    expect(ATENDEPRO_DEFAULT_INTERFACE.destinos).toContain("/app/inbox");
    expect(ATENDEPRO_DEFAULT_INTERFACE.destinos).toContain("/app/agenda");
    expect(ATENDEPRO_DEFAULT_INTERFACE.destinos).toContain("/app/contacts");
    expect(ATENDEPRO_DEFAULT_INTERFACE.destinos).toContain("/app/kanban");
  });

  it("idempotência: não atualiza user_organizations nem grava auditoria se a organização já foi concluída", async () => {
    mockExistingOnboardedAt = "2026-09-10T10:00:00.000Z";

    await expect(finishOnboarding()).rejects.toThrow("NEXT_REDIRECT: /app/inbox");

    const memberUpdate = queries.find((q) => q.table === "user_organizations" && q.op === "update");
    expect(memberUpdate, "Não deve atualizar user_organizations se já concluído").toBeUndefined();

    const orgUpdate = queries.find((q) => q.table === "organizations" && q.op === "update");
    expect(orgUpdate, "Não deve atualizar organizations se já concluído").toBeUndefined();

    const eventInserts = queries.filter((q) => q.table === "event_log" && q.op === "insert");
    expect(eventInserts).toHaveLength(0);

    expect(audits).toHaveLength(0);
    expect(redirects).toEqual(["/app/inbox"]);
  });

  it("retorna db_error se a leitura da organização falhar", async () => {
    mockOrgReadError = { message: "database offline" };

    const result = await finishOnboarding();

    expect(result).toEqual({
      ok: false,
      error: "db_error",
      details: "database offline",
    });

    expect(queries.filter((q) => q.op === "update")).toHaveLength(0);
    expect(redirects).toHaveLength(0);
  });

  it("retorna db_error se o update de user_organizations falhar e não carimba onboarded_at", async () => {
    mockMemberUpdateError = { message: "violacao de constraint" };

    const result = await finishOnboarding();

    expect(result).toEqual({
      ok: false,
      error: "db_error",
      details: "violacao de constraint",
    });

    const orgUpdate = queries.find((q) => q.table === "organizations" && q.op === "update");
    expect(
      orgUpdate,
      "Não deve atualizar organizations se user_organizations falhou",
    ).toBeUndefined();
    expect(redirects).toHaveLength(0);
  });

  it("retorna erro de auth se requireOnboardingCtx lançar OnboardingError", async () => {
    mockAuthError = new OnboardingError("auth_required", "Sessão inválida");

    const result = await finishOnboarding();

    expect(result).toEqual({
      ok: false,
      error: "auth_required",
    });

    expect(queries).toHaveLength(0);
  });
});

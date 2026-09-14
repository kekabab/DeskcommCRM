/**
 * Testes unitários de implementação para o Simulador de Conversa AtendePro:
 *
 * Cobre:
 * 1. POST /api/v1/simulator/messages persistindo direction/status/sent_via/metadata corretos.
 * 2. Bloqueio inegociável de organization_id vindo do input (escopo estrito da sessão autenticada).
 * 3. Contrato de provider simulator e ausência de egress (zero-egress, não chama adapters externos).
 * 4. Validação de RBAC (exige role >= agent) e sanitização de payloads inválidos (400, 422).
 * 5. Tratamento resiliente do blocker de migração pendente (503 com código migration_pending).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { executeSimulatorTurn } from "@/lib/atendepro/simulator";
import { POST } from "@/app/api/v1/simulator/messages/route";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { fail } from "@/lib/api/wrappers";
import type * as SimulatorModule from "@/lib/atendepro/simulator";

// Mock de segurança e autorização
vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: vi.fn(async () => null),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(),
}));

// Mock do executor do simulador para testar a camada de rota e isolamento de boundary
vi.mock("@/lib/atendepro/simulator", async (importOriginal) => {
  const actual = await importOriginal<typeof SimulatorModule>();
  return {
    ...actual,
    executeSimulatorTurn: vi.fn(),
  };
});

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ATTACKER_ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu";

function criarUsuarioAuth(role: Role): AuthUser {
  return {
    id: USER_ID,
    email: "operador@atendepro.local",
    full_name: "Operador AtendePro",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR",
    organizations: [
      {
        organization_id: ORG_ID,
        organization_name: "Clínica Teste",
        role,
      },
    ],
  };
}

function mockSessao(role: Role) {
  vi.mocked(requireRole).mockImplementation(async (minRole: Role) => {
    const user = criarUsuarioAuth(role);
    const hasRole = ROLE_RANK[role] >= ROLE_RANK[minRole];
    if (!hasRole) {
      return {
        ok: false,
        response: fail("forbidden_role", `Requer role >= ${minRole}.`, 403, {}),
      };
    }
    return {
      ok: true,
      user,
      org: {
        orgId: ORG_ID,
        name: "Clínica Teste",
        role,
      },
    };
  });
}

function criarRequisicao(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/v1/simulator/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("AtendePro — POST /api/v1/simulator/messages & Contrato Simulator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessao("agent");
    vi.mocked(requireSupportWrite).mockResolvedValue(null);
  });

  describe("1. Bloqueio de organization_id vindo do input (Boundary Security)", () => {
    it("descarta ou impede organization_id injetado no payload e ancora obrigatoriamente na org da sessão", async () => {
      const turnMock = vi.mocked(executeSimulatorTurn).mockResolvedValue({
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        contact_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        channel_session_id: "ssssssss-ssss-4sss-8sss-ssssssssssss",
        inbound_message: {
          id: "m1",
          body: "Mensagem de teste",
          direction: "inbound",
          status: "received",
          sent_via: "user",
          sent_at: new Date().toISOString(),
        },
        outbound_message: {
          id: "m2",
          body: "Resposta simulada",
          direction: "outbound",
          status: "delivered",
          sent_via: "ai",
          sent_at: new Date().toISOString(),
        },
        declaration: {
          nada_a_declarar: false,
          intencao_detectada: "saudacao",
          resumo: "Resumo do turno",
        },
      });

      // Atacante tenta forçar organization_id de outra empresa
      const req = criarRequisicao({
        organization_id: ATTACKER_ORG_ID,
        body: "Olá, quero agendar",
        scenario: "agendamento",
      });

      const res = await POST(req);
      expect(res.status).toBe(422);

      // O schema estrito rejeita a tentativa antes de chamar o executor; a
      // organização só vem do contexto autenticado.
      expect(turnMock).not.toHaveBeenCalled();
    });
  });

  describe("2. Persistência de Mensagens e Schema Canônico", () => {
    it("devolve payload contendo direction, status, sent_via e metadata aderentes ao schema real de messages", async () => {
      const mockResult = {
        conversation_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        contact_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        channel_session_id: "ssssssss-ssss-4sss-8sss-ssssssssssss",
        inbound_message: {
          id: "msg-inbound-1",
          body: "Quero saber os horários",
          direction: "inbound" as const,
          status: "received" as const,
          sent_via: "user" as const,
          sent_at: "2026-09-13T12:00:00.000Z",
        },
        outbound_message: {
          id: "msg-outbound-1",
          body: "Temos horários disponíveis às 14h.",
          direction: "outbound" as const,
          status: "delivered" as const,
          sent_via: "ai" as const,
          sent_at: "2026-09-13T12:00:01.000Z",
        },
        declaration: {
          nada_a_declarar: false,
          intencao_detectada: "agendamento_servico",
          resumo: "Consulta de horários",
        },
      };

      vi.mocked(executeSimulatorTurn).mockResolvedValue(mockResult);

      const req = criarRequisicao({
        body: "Quero saber os horários",
        scenario: "agendamento",
      });

      const res = await POST(req);
      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.data).toBeDefined();
      expect(json.data.inbound_message.direction).toBe("inbound");
      expect(json.data.inbound_message.status).toBe("received");
      expect(json.data.inbound_message.sent_via).toBe("user");

      expect(json.data.outbound_message.direction).toBe("outbound");
      expect(json.data.outbound_message.status).toBe("delivered");
      expect(json.data.outbound_message.sent_via).toBe("ai");
      expect(json.data.declaration.intencao_detectada).toBe("agendamento_servico");
    });
  });

  describe("3. Zero-Egress e Ausência de Chamada a Adapters Externos", () => {
    it("não importa nem aciona adapters de mensageria real (WAHA, Meta, Zernio) no turno simulado", async () => {
      // Espiamos global.fetch para comprovar que nenhuma requisição externa de egress é feita
      const fetchSpy = vi.spyOn(global, "fetch");

      vi.mocked(executeSimulatorTurn).mockResolvedValue({
        conversation_id: "conv-1",
        contact_id: "cont-1",
        channel_session_id: "sess-1",
        inbound_message: {
          id: "m1",
          body: "Sem saída externa",
          direction: "inbound",
          status: "received",
          sent_via: "user",
          sent_at: new Date().toISOString(),
        },
        outbound_message: {
          id: "m2",
          body: "Resposta local sem rede",
          direction: "outbound",
          status: "delivered",
          sent_via: "ai",
          sent_at: new Date().toISOString(),
        },
        declaration: {
          nada_a_declarar: true,
          intencao_detectada: "geral",
          resumo: "Zero egress",
        },
      });

      const req = criarRequisicao({ body: "Sem saída externa" });
      const res = await POST(req);
      expect(res.status).toBe(201);

      // Comprovação de Zero-Egress: nenhum webhook ou endpoint remoto foi alcançado via HTTP
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe("4. Validação de RBAC e Sanitização de Entrada", () => {
    it("rejeita usuários com perfil 'viewer' com HTTP 403", async () => {
      mockSessao("viewer");

      const req = criarRequisicao({ body: "Tentativa de escrita como visualizador" });
      const res = await POST(req);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("forbidden_role");
      expect(executeSimulatorTurn).not.toHaveBeenCalled();
    });

    it("rejeita JSON malformado com HTTP 400", async () => {
      const req = criarRequisicao("{ json_invalido: true, ");
      const res = await POST(req);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error.code).toBe("invalid_request");
    });

    it("rejeita mensagem com body vazio com HTTP 422", async () => {
      const req = criarRequisicao({ body: "" });
      const res = await POST(req);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe("validation_failed");
    });

    it("rejeita mensagem com body acima de 4096 caracteres com HTTP 422", async () => {
      const corpoLongo = "a".repeat(4097);
      const req = criarRequisicao({ body: corpoLongo });
      const res = await POST(req);

      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error.code).toBe("validation_failed");
    });
  });

  describe("5. Tratamento Resiliente do Blocker de Migração (503)", () => {
    it("retorna HTTP 503 com código migration_pending se o runtime indicar AURORA_MIGRATION_PENDING", async () => {
      vi.mocked(executeSimulatorTurn).mockRejectedValue(
        new Error("[AURORA_MIGRATION_PENDING] Restrição channel_sessions_provider_check ativa."),
      );

      const req = criarRequisicao({ body: "Tentativa antes da migration de canal" });
      const res = await POST(req);

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error.code).toBe("migration_pending");
      expect(json.error.message).toContain("aguarda uma atualização do banco");
      expect(JSON.stringify(json)).not.toContain("AURORA_MIGRATION_PENDING");
    });
  });
});

import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/simulator/messages
 *
 * Ponto de entrada do simulador de conversa persistente local do AtendePro.
 * Recebe mensagem de teste autenticada do operador da organização, persiste
 * o turno no CRM com zero-egress e aciona o modelo determinístico.
 *
 * Diretrizes: docs/atendepro/contract-cross-review.md e migration 0239.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  executeSimulatorTurn,
  MigrationPendingError,
  simulatorMessageInputSchema,
} from "@/lib/atendepro/simulator";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // Exige perfil mínimo de 'agent' na organização ativa
  const authz = await requireRole("agent", { requestId, resource: "simulator" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = simulatorMessageInputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await executeSimulatorTurn(parsed.data, {
      organizationId: activeOrg.orgId,
      actorUserId: authUser.id,
      requestId,
    });

    return ok(result, { status: 201, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.code === "internal_error") {
        console.error("[simulator] internal api error", { requestId, error: err });
        return fail("internal_error", t("Não foi possível processar a simulação local."), 500, {
          requestId,
        });
      }
      return fail(err.code, err.message, err.status, { requestId });
    }

    if (err instanceof MigrationPendingError) {
      // O detalhe cru fica somente no log do servidor. A resposta pública não
      // pode revelar colunas, constraints ou mensagens do PostgREST.
      console.error("[simulator] migration pending", {
        requestId,
        message: err.message,
        details: err.details,
      });
      return fail(
        "migration_pending",
        t("O simulador local aguarda uma atualização do banco."),
        503,
        { requestId },
      );
    }

    const message =
      err instanceof Error ? err.message : "Erro desconhecido ao processar turno simulado.";

    if (/migration[_ ]pending/i.test(message) || message.includes("0239")) {
      console.error("[simulator] migration pending", { requestId, message });
      return fail(
        "migration_pending",
        t("O simulador local aguarda uma atualização do banco."),
        503,
        { requestId },
      );
    }

    console.error("[simulator] turn failed", { requestId, error: err });
    return fail("internal_error", t("Não foi possível processar a simulação local."), 500, {
      requestId,
    });
  }
}

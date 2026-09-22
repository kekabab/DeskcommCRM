/**
 * PATCH /api/v1/opportunity-intelligence/actions/[id]
 *
 * Permite ao operador aprovar ou rejeitar uma ação proposta no modo Copiloto.
 * O sistema nunca dispara mensagens automaticamente; a aprovação move o estado
 * para action_ready e emite o evento canônico para geração de rascunhos.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { reviewOpportunityAction } from "@/lib/opportunity-intelligence/write";
import { checkOpportunityMutationRate } from "@/lib/opportunity-intelligence/limits";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const reviewActionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).nullable().optional(),
  lead_id: z.string().uuid().nullable().optional(),
});

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", {
    requestId,
    resource: "opportunity_actions",
  });
  if (!authz.ok) return authz.response;
  const rate = await checkOpportunityMutationRate(
    req,
    authz.org.orgId,
    authz.user.id,
    "action_review",
  );
  if (!rate.allowed) {
    return fail("rate_limited", "Muitas revisões de oportunidade em pouco tempo.", 429, {
      requestId,
      headers: { "Retry-After": String(rate.window_sec) },
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("body_malformed", "JSON inválido.", 400, { requestId });
  }

  const parsed = reviewActionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Decisão de ação inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await reviewOpportunityAction(createAdminClient(), {
      organization_id: authz.org.orgId,
      action_id: id,
      status: parsed.data.status,
      user_id: authz.user.id,
      reason: parsed.data.reason ?? null,
      lead_id: parsed.data.lead_id ?? null,
    });
    return ok(result, { requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (message.startsWith("opportunity_action_not_found:")) {
      return fail("not_found", "Ação de oportunidade não encontrada.", 404, { requestId });
    }
    if (
      message === "cannot_modify_executed_action" ||
      message === "cannot_modify_blocked_action" ||
      message === "cannot_modify_action_for_suppressed_opportunity" ||
      message === "opportunity_evidence_stale_at_approval"
    ) {
      return fail("conflict", `Não é possível alterar esta ação (${message}).`, 409, { requestId });
    }
    return fail("internal_error", "Não foi possível registrar a decisão da ação.", 500, {
      requestId,
    });
  }
}

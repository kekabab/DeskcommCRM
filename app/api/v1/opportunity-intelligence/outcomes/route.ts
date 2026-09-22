/**
 * POST /api/v1/opportunity-intelligence/outcomes
 *
 * Registra a resposta observada para fechar o ciclo da oportunidade. A rota
 * nunca envia mensagem: ela só grava o outcome determinístico e deixa o
 * event_log acionar o worker de aprendizado/CRM.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { OPPORTUNITY_OUTCOME_KINDS } from "@/lib/opportunity-intelligence/domain";
import { recordOpportunityOutcome } from "@/lib/opportunity-intelligence/write";
import { checkOpportunityMutationRate } from "@/lib/opportunity-intelligence/limits";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const outcomeRequestSchema = z.object({
  opportunity_id: z.string().uuid(),
  action_id: z.string().uuid().nullable().optional(),
  idempotency_key: z.string().trim().min(1).max(200),
  kind: z.enum(OPPORTUNITY_OUTCOME_KINDS),
  reason: z.string().trim().max(500).nullable().optional(),
  metrics: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "opportunity_outcomes",
  });
  if (!authz.ok) return authz.response;
  const rate = await checkOpportunityMutationRate(req, authz.org.orgId, authz.user.id, "outcome");
  if (!rate.allowed) {
    return fail("rate_limited", "Muitos resultados de oportunidade em pouco tempo.", 429, {
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

  const parsed = outcomeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Outcome inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await recordOpportunityOutcome(createAdminClient(), {
      organization_id: authz.org.orgId,
      ...parsed.data,
      user_id: authz.user.id,
    });
    return ok(result, { requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (message.startsWith("opportunity_not_found:")) {
      return fail("not_found", "Oportunidade não encontrada.", 404, { requestId });
    }
    if (message === "cannot_record_outcome_on_suppressed_opportunity") {
      return fail("conflict", "Uma oportunidade suprimida não aceita novos outcomes.", 409, {
        requestId,
      });
    }
    return fail("internal_error", "Não foi possível registrar o outcome.", 500, { requestId });
  }
}

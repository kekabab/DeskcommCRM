/**
 * GET /api/v1/opportunity-intelligence/dossier/[id]
 *
 * Retorna o dossiê estruturado da oportunidade pelo padrão FACT:
 * - Fato (evidências observadas)
 * - Âncora & Frescor (fontes com URL, data e status)
 * - Consequência (hipótese de dor comercial)
 * - Prova Tangível (diagnóstico e oferta sugerida)
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { loadOpportunityDossier } from "@/lib/opportunity-intelligence/read";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("viewer", {
    requestId,
    resource: "opportunity_dossier",
  });
  if (!authz.ok) return authz.response;

  try {
    const supabase = await createClient();
    const dossier = await loadOpportunityDossier(supabase, authz.org.orgId, id);

    if (!dossier) {
      return fail("not_found", "Dossiê da oportunidade não encontrado.", 404, {
        requestId,
      });
    }

    return ok(dossier, { requestId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    return fail("internal_error", `Erro ao carregar dossiê: ${message}`, 500, {
      requestId,
    });
  }
}

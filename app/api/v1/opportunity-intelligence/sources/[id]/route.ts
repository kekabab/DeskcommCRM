import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  getTenantOpportunityQuota,
  loadSingleOpportunitySourceView,
} from "@/lib/opportunity-intelligence/quotas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const patchSourceSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  regions: z.array(z.string().trim().min(1).max(80)).min(1).max(50).optional(),
  rate_limit_per_minute: z.number().int().min(1).max(100_000).optional(),
  max_records_per_run: z.number().int().min(1).max(100).optional(),
  is_active: z.boolean().optional(),
});

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "opportunity_source_configs" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  try {
    const client = await createClient();
    const result = await loadSingleOpportunitySourceView(client, authz.org.orgId, id);
    if (!result) return fail("not_found", "Fonte não encontrada.", 404, { requestId });

    return ok(result, { requestId });
  } catch (error) {
    return fail(
      "internal_error",
      error instanceof Error ? error.message : "Erro ao carregar detalhes da fonte.",
      500,
      { requestId },
    );
  }
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "opportunity_source_configs" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("body_malformed", "JSON inválido.", 400, { requestId });
  }

  const parsed = patchSourceSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Dados de atualização inválidos.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const client = await createClient();

  const { data: existing, error: existingError } = await client
    .from("opportunity_source_configs")
    .select("id, is_active")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();

  if (existingError) {
    return fail("internal_error", "Erro ao verificar fonte existente.", 500, { requestId });
  }
  if (!existing) {
    return fail("not_found", "Fonte não encontrada.", 404, { requestId });
  }

  // Quota check if activating an inactive source
  if (parsed.data.is_active === true && !existing.is_active) {
    const quota = await getTenantOpportunityQuota(client, authz.org.orgId);
    if (!quota.sources.can_activate_more) {
      return fail(
        "quota_exceeded",
        `Limite de fontes ativas atingido para este tenant (${quota.sources.max_active} fontes).`,
        422,
        {
          requestId,
          details: {
            max_active: quota.sources.max_active,
            current_active: quota.sources.current_active,
          },
        },
      );
    }
  }

  const updateFields: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (parsed.data.name !== undefined) updateFields.name = parsed.data.name;
  if (parsed.data.regions !== undefined) updateFields.regions = parsed.data.regions;
  if (parsed.data.rate_limit_per_minute !== undefined)
    updateFields.rate_limit_per_minute = parsed.data.rate_limit_per_minute;
  if (parsed.data.max_records_per_run !== undefined)
    updateFields.max_records_per_run = parsed.data.max_records_per_run;
  if (parsed.data.is_active !== undefined) updateFields.is_active = parsed.data.is_active;

  const { error: updateError } = await client
    .from("opportunity_source_configs")
    .update(updateFields)
    .eq("organization_id", authz.org.orgId)
    .eq("id", id);

  if (updateError) {
    return fail("update_failed", "Não foi possível atualizar a fonte.", 500, { requestId });
  }

  // Post-mutation concurrency check if activating: re-verify active sources count
  if (parsed.data.is_active === true && !existing.is_active) {
    const quota = await getTenantOpportunityQuota(client, authz.org.orgId);
    if (quota.sources.current_active > quota.sources.max_active) {
      // Compensatory rollback: revert back to is_active: false
      await client
        .from("opportunity_source_configs")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("organization_id", authz.org.orgId)
        .eq("id", id);

      return fail(
        "quota_concurrency_conflict",
        `Conflito de concorrência: o limite de fontes ativas (${quota.sources.max_active}) foi ultrapassado por outra ativação simultânea. A fonte foi revertida para inativa.`,
        409,
        {
          requestId,
          details: {
            max_active: quota.sources.max_active,
            current_active: quota.sources.current_active,
          },
        },
      );
    }
  }

  const updatedView = await loadSingleOpportunitySourceView(client, authz.org.orgId, id);
  return ok(updatedView, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "opportunity_source_configs" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  const client = await createClient();
  const { error } = await client
    .from("opportunity_source_configs")
    .delete()
    .eq("organization_id", authz.org.orgId)
    .eq("id", id);

  if (error) {
    return fail("delete_failed", "Não foi possível excluir a fonte.", 500, { requestId });
  }

  return ok({ deleted: true, id }, { requestId });
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { assertPublicHttpsUrl } from "@/lib/opportunity-intelligence/adapters/json-feed";
import { sourceAdapterManifestSchema } from "@/lib/opportunity-intelligence/sources";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const sourceConfigRequestSchema = z.object({
  source_id: sourceAdapterManifestSchema.shape.source_id,
  name: z.string().trim().min(1).max(160),
  source_kind: sourceAdapterManifestSchema.shape.source_kind,
  feed_url: z.string().url(),
  terms_url: z.string().url(),
  regions: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
  niche: z.string().trim().min(1).max(100).default("servicos_digitais"),
  offer_key: z.string().trim().min(1).max(100).default("otimizacao_conversao_local"),
  rate_limit_per_minute: z.number().int().min(1).max(100_000).default(60),
  max_records_per_run: z.number().int().min(1).max(100).default(100),
  is_active: z.boolean().default(true),
});

const SOURCE_COLUMNS =
  "id, organization_id, source_id, name, source_kind, feed_url, terms_url, regions, niche, offer_key, rate_limit_per_minute, max_records_per_run, is_active, last_synced_at, last_error, created_at, updated_at";

import {
  getTenantOpportunityQuota,
  loadOpportunitySourceViews,
} from "@/lib/opportunity-intelligence/quotas";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "opportunity_source_configs" });
  if (!authz.ok) return authz.response;

  try {
    const client = await createClient();
    const result = await loadOpportunitySourceViews(client, authz.org.orgId);
    return ok(result, { requestId });
  } catch (error) {
    return fail(
      "internal_error",
      error instanceof Error ? error.message : "Não foi possível listar as fontes e quotas.",
      500,
      { requestId },
    );
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "opportunity_source_configs" });
  if (!authz.ok) return authz.response;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("body_malformed", "JSON inválido.", 400, { requestId });
  }
  const parsed = sourceConfigRequestSchema.safeParse(rawBody);
  if (!parsed.success)
    return fail("validation_failed", "Configuração de fonte inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });

  if (
    parsed.data.source_kind === "tenant_first_party" &&
    parsed.data.feed_url.includes("/public/")
  ) {
    return fail(
      "source_policy_invalid",
      "Uma fonte first-party não pode ser cadastrada como feed público.",
      422,
      { requestId },
    );
  }
  try {
    await assertPublicHttpsUrl(parsed.data.feed_url);
    await assertPublicHttpsUrl(parsed.data.terms_url);
  } catch (error) {
    return fail(
      "source_url_blocked",
      error instanceof Error ? error.message : "URL de fonte bloqueada.",
      422,
      { requestId },
    );
  }

  const client = await createClient();

  // Enforce tenant quota on active sources
  if (parsed.data.is_active) {
    const quota = await getTenantOpportunityQuota(client, authz.org.orgId);
    const { data: existing } = await client
      .from("opportunity_source_configs")
      .select("id, is_active")
      .eq("organization_id", authz.org.orgId)
      .eq("source_id", parsed.data.source_id)
      .maybeSingle();

    const isAlreadyActive = existing?.is_active === true;
    if (!isAlreadyActive && !quota.sources.can_activate_more) {
      return fail(
        "quota_exceeded",
        `Limite de fontes ativas atingido para este tenant (máximo: ${quota.sources.max_active}).`,
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

  const { data, error } = await client
    .from("opportunity_source_configs")
    .upsert(
      {
        ...parsed.data,
        organization_id: authz.org.orgId,
        created_by_user_id: authz.user.id,
      },
      { onConflict: "organization_id,source_id" },
    )
    .select(SOURCE_COLUMNS)
    .single();
  if (error)
    return fail("source_save_failed", "Não foi possível salvar a fonte.", 500, { requestId });

  // Post-mutation concurrency check: re-verify active sources count
  if (parsed.data.is_active) {
    const quota = await getTenantOpportunityQuota(client, authz.org.orgId);
    if (quota.sources.current_active > quota.sources.max_active) {
      // Compensatory rollback: deactivate the newly activated source
      await client
        .from("opportunity_source_configs")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("organization_id", authz.org.orgId)
        .eq("id", data.id);

      return fail(
        "quota_concurrency_conflict",
        `Conflito de concorrência: o limite de fontes ativas (${quota.sources.max_active}) foi ultrapassado por outra operação concorrente. A fonte foi salva como inativa.`,
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

  return ok(data, { requestId, status: 201 });
}

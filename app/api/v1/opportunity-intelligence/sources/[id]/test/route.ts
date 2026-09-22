import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createJsonFeedAdapter } from "@/lib/opportunity-intelligence/adapters/json-feed";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "opportunity_source_configs" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const client = await createClient();
  const { data: source, error } = await client
    .from("opportunity_source_configs")
    .select(
      "id, organization_id, source_id, source_kind, feed_url, terms_url, regions, rate_limit_per_minute, max_records_per_run",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("source_read_failed", "Não foi possível ler a fonte.", 500, { requestId });
  if (!source) return fail("not_found", "Fonte não encontrada.", 404, { requestId });

  try {
    const adapter = createJsonFeedAdapter({
      manifest: {
        source_id: source.source_id,
        source_kind: source.source_kind,
        terms_url: source.terms_url,
        allow_automated_collection: true,
        rate_limit_per_minute: source.rate_limit_per_minute,
        supports_regions: source.regions,
      },
      feed_url: source.feed_url,
      max_records_per_run: source.max_records_per_run,
    });
    const candidates = await adapter.discover({
      organization_id: authz.org.orgId,
      region: source.regions[0] ?? "GLOBAL",
      niche: "test",
      offer_key: "test",
    });
    return ok(
      {
        source_id: source.source_id,
        candidates: candidates.length,
        safe: true,
        outbound: "blocked",
      },
      { requestId },
    );
  } catch (error) {
    return fail(
      "source_test_failed",
      error instanceof Error ? error.message : "Falha ao testar a fonte.",
      422,
      { requestId },
    );
  }
}

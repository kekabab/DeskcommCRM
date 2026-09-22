import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createJsonFeedAdapter } from "@/lib/opportunity-intelligence/adapters/json-feed";
import {
  DEFAULT_TENANT_SOURCE_QUOTA,
  type QuotaCheckResult,
} from "@/lib/opportunity-intelligence/limits";
import { runOpportunityDiscovery } from "@/workers/opportunity-discovery-worker";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const CONFIG_LIMIT = 50;
const CYCLE_TIMEOUT_MS = 90_000;

type SourceConfig = {
  id: string;
  organization_id: string;
  source_id: string;
  source_kind: "open_data" | "official_api" | "tenant_first_party";
  feed_url: string;
  terms_url: string;
  regions: string[];
  niche: string;
  offer_key: string;
  rate_limit_per_minute: number;
  max_records_per_run: number;
  last_synced_at?: string | null;
  last_error?: string | null;
};

function windowKey(now = new Date()): string {
  return now.toISOString().slice(0, 13);
}

function validCronSecret(req: NextRequest): boolean {
  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  return accepted.length > 0 && Boolean(provided) && accepted.includes(provided);
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!validCronSecret(req))
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("opportunity_source_configs")
    .select(
      "id, organization_id, source_id, source_kind, feed_url, terms_url, regions, niche, offer_key, rate_limit_per_minute, max_records_per_run",
    )
    .eq("is_active", true)
    .limit(CONFIG_LIMIT);
  if (error) {
    logger.error("[opportunity-discovery] source config query failed", {
      requestId,
      error: error.message,
    });
    return fail("internal_error", "Failed to list opportunity sources.", 500, { requestId });
  }

  const currentWindow = windowKey();
  let attempted = 0;
  let skipped = 0;
  let candidates = 0;
  let opportunities = 0;
  const errors: Array<{ organization_id?: string; source_id?: string; message: string }> = [];
  const cycleDeadline = Date.now() + CYCLE_TIMEOUT_MS;

  const sources = (data ?? []) as unknown as SourceConfig[];
  for (const [sourceIndex, source] of sources.entries()) {
    if (Date.now() >= cycleDeadline) {
      const remaining = sources.length - sourceIndex;
      skipped += remaining;
      errors.push({ message: "discovery_cycle_timeout" });
      break;
    }
    const { data: claim, error: claimError } = await admin
      .from("opportunity_discovery_runs")
      .upsert(
        {
          organization_id: source.organization_id,
          source_config_id: source.id,
          source_id: source.source_id,
          window_key: currentWindow,
          status: "running",
        },
        { onConflict: "organization_id,source_id,window_key", ignoreDuplicates: true },
      )
      .select("id")
      .maybeSingle();

    if (claimError) {
      errors.push({
        organization_id: source.organization_id,
        source_id: source.source_id,
        message: claimError.message,
      });
      continue;
    }
    if (!claim?.id) {
      skipped += 1;
      continue;
    }

    attempted += 1;
    const audit = await admin.from("api_audit_log").insert({
      organization_id: source.organization_id,
      actor_user_id: null,
      action: "opportunity.discovery_sweep",
      resource_type: "opportunity_source_configs",
      resource_id: source.id,
      request_id: requestId,
      metadata: { window_key: currentWindow, source_id: source.source_id },
    });
    if (audit.error) {
      logger.warn("[opportunity-discovery] audit insert failed", {
        requestId,
        organization_id: source.organization_id,
        source_id: source.source_id,
        error: audit.error.message,
      });
    }

    // Validação atômica e serializada de quota ANTES do fetch via RPC transacional (FOR UPDATE)
    const cost = 1.0;
    const capacity = source.rate_limit_per_minute ?? DEFAULT_TENANT_SOURCE_QUOTA.capacity;
    const refillRatePerMinute =
      source.rate_limit_per_minute ?? DEFAULT_TENANT_SOURCE_QUOTA.refillRatePerMinute;

    const { data: quotaRpcData, error: quotaRpcError } = await admin.rpc(
      "consume_opportunity_source_quota" as never,
      {
        p_organization_id: source.organization_id,
        p_source_id: source.source_id,
        p_cost: cost,
        p_capacity: capacity,
        p_refill_rate_per_minute: refillRatePerMinute,
      } as never,
    );

    if (quotaRpcError) {
      const rpcErrorMessage = `Quota RPC failed for source '${source.source_id}': ${quotaRpcError.message}`;
      logger.error("[opportunity-discovery] quota rpc failed", {
        requestId,
        organization_id: source.organization_id,
        source_id: source.source_id,
        error: quotaRpcError.message,
      });
      errors.push({
        organization_id: source.organization_id,
        source_id: source.source_id,
        message: rpcErrorMessage,
      });
      await admin
        .from("opportunity_discovery_runs")
        .update({
          status: "failed",
          candidates_seen: 0,
          opportunities_created: 0,
          errors: [
            { code: "quota_rpc_error", source_id: source.source_id, message: rpcErrorMessage },
          ],
          finished_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .eq("organization_id", source.organization_id);

      await admin
        .from("opportunity_source_configs")
        .update({
          last_error: rpcErrorMessage,
        })
        .eq("id", source.id)
        .eq("organization_id", source.organization_id);

      continue;
    }

    const rpcResult = quotaRpcData as {
      allowed?: boolean;
      tokens_remaining?: number;
      cost?: number;
      retry_after_seconds?: number;
      capacity?: number;
      refill_rate_per_minute?: number;
      last_refill_at?: string;
    } | null;

    const quotaDecision: QuotaCheckResult = {
      allowed: Boolean(rpcResult?.allowed),
      remainingTokens: Number(rpcResult?.tokens_remaining ?? 0),
      retryAfterSeconds: Number(rpcResult?.retry_after_seconds ?? 0),
      nextState: {
        tokens: Number(rpcResult?.tokens_remaining ?? 0),
        lastRefillAt: String(rpcResult?.last_refill_at ?? new Date().toISOString()),
      },
    };

    if (!quotaDecision.allowed) {
      // Quota excedida: registrar no ledger (opportunity_discovery_runs),
      // no source_config e na lista explicável de erros sem realizar fetch
      const quotaError = {
        organization_id: source.organization_id,
        source_id: source.source_id,
        code: "quota_exceeded",
        message: `Tenant quota exceeded for source '${source.source_id}'. Deficit: retry in ${quotaDecision.retryAfterSeconds}s (tokens remaining: ${quotaDecision.remainingTokens}).`,
      };
      errors.push(quotaError);

      await admin
        .from("opportunity_discovery_runs")
        .update({
          status: "failed",
          candidates_seen: 0,
          opportunities_created: 0,
          errors: [
            {
              code: "quota_exceeded",
              source_id: source.source_id,
              message: quotaError.message,
              retry_after_seconds: quotaDecision.retryAfterSeconds,
            },
          ],
          finished_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .eq("organization_id", source.organization_id);

      await admin
        .from("opportunity_source_configs")
        .update({
          last_error: quotaError.message,
        })
        .eq("id", source.id)
        .eq("organization_id", source.organization_id);

      continue;
    }

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
      const result = await runOpportunityDiscovery({
        client: admin,
        organization_id: source.organization_id,
        region: source.regions[0] ?? "GLOBAL",
        niche: source.niche,
        offer_key: source.offer_key,
        adapters: [adapter],
        quota: { preauthorized: quotaDecision },
      });
      candidates += result.candidates_discovered;
      opportunities += result.opportunities_processed;
      errors.push(
        ...result.errors.map((item) => ({
          organization_id: source.organization_id,
          source_id: item.source_id ?? source.source_id,
          message: item.message,
        })),
      );
      await admin
        .from("opportunity_discovery_runs")
        .update({
          status: result.errors.length > 0 ? "failed" : "succeeded",
          candidates_seen: result.candidates_discovered,
          opportunities_created: result.opportunities_processed,
          errors: result.errors,
          finished_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .eq("organization_id", source.organization_id);
      await admin
        .from("opportunity_source_configs")
        .update({
          last_synced_at: new Date().toISOString(),
          last_error:
            result.errors.length > 0
              ? result.errors
                  .map((item) => item.message)
                  .join("; ")
                  .slice(0, 1000)
              : null,
        })
        .eq("id", source.id)
        .eq("organization_id", source.organization_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown discovery source error";
      errors.push({
        organization_id: source.organization_id,
        source_id: source.source_id,
        message,
      });
      await admin
        .from("opportunity_discovery_runs")
        .update({
          status: "failed",
          errors: [{ message }],
          finished_at: new Date().toISOString(),
        })
        .eq("id", claim.id)
        .eq("organization_id", source.organization_id);
      await admin
        .from("opportunity_source_configs")
        .update({ last_error: message.slice(0, 1000) })
        .eq("id", source.id)
        .eq("organization_id", source.organization_id);
    }
  }

  return ok(
    {
      sources_attempted: attempted,
      sources_skipped: skipped,
      candidates_seen: candidates,
      opportunities_created: opportunities,
      errors,
      outbound: "blocked",
    },
    { requestId },
  );
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}
export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}

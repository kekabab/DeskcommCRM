import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_TENANT_SOURCE_QUOTA,
  OPPORTUNITY_MUTATION_LIMITS,
  OPPORTUNITY_MUTATION_WINDOW_SECONDS,
} from "@/lib/opportunity-intelligence/limits";

export type OpportunitySourceStatus = "healthy" | "running" | "failed" | "idle" | "inactive";

export type OpportunitySourceRunView = {
  run_id: string;
  window_key: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  candidates_seen: number;
  opportunities_created: number;
  errors: Array<{ message: string; code?: string }>;
  started_at: string;
  finished_at: string | null;
};

export type OpportunitySourceView = {
  id: string;
  organization_id: string;
  source_id: string;
  name: string;
  source_kind: "open_data" | "official_api" | "tenant_first_party";
  feed_url: string;
  terms_url: string;
  regions: string[];
  niche: string;
  offer_key: string;
  rate_limit_per_minute: number;
  max_records_per_run: number;
  is_active: boolean;
  status: OpportunitySourceStatus;
  last_synced_at: string | null;
  last_error: string | null;
  last_execution: OpportunitySourceRunView | null;
  created_at: string;
  updated_at: string;
};

export type TenantOpportunityQuota = {
  organization_id: string;
  sources: {
    max_active: number;
    current_active: number;
    total_registered: number;
    can_activate_more: boolean;
  };
  opportunities: {
    monthly_limit: number;
    created_this_month: number;
    remaining_this_month: number;
    total_records: number;
  };
  sweeps: {
    max_records_per_run_ceiling: number;
    sweeps_today: number;
  };
  rate_limits: {
    intake_per_minute: number;
    action_review_per_minute: number;
    outcome_per_minute: number;
    window_seconds: number;
  };
  token_bucket: {
    capacity: number;
    refill_rate_per_minute: number;
  };
  governance: {
    copilot_mode: true;
    outbound_status: "blocked";
  };
};

const DEFAULT_MAX_ACTIVE_SOURCES = 5;
const DEFAULT_MONTHLY_OPPORTUNITY_LIMIT = 500;
const MAX_RECORDS_PER_RUN_CEILING = 100;

export function deriveSourceStatus(
  source: { is_active: boolean; last_error?: string | null },
  latestRun?: { status: string; errors?: unknown } | null,
): OpportunitySourceStatus {
  if (!source.is_active) return "inactive";
  if (latestRun?.status === "running") return "running";
  if (source.last_error || latestRun?.status === "failed") return "failed";
  if (latestRun?.status === "succeeded") return "healthy";
  return "idle";
}

export async function getTenantOpportunityQuota(
  client: SupabaseClient,
  organizationId: string,
): Promise<TenantOpportunityQuota> {
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [sourcesRes, orgRes, totalOppRes, monthOppRes, todayRunsRes] = await Promise.all([
    client
      .from("opportunity_source_configs")
      .select("id, is_active")
      .eq("organization_id", organizationId),
    client.from("organizations").select("settings").eq("id", organizationId).maybeSingle(),
    client
      .from("opportunity_records")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId),
    client
      .from("opportunity_records")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("created_at", startOfMonth),
    client
      .from("opportunity_discovery_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("started_at", twentyFourHoursAgo),
  ]);

  if (sourcesRes.error) {
    throw new Error(
      `tenant_quota_sources_read_failed: falha ao consultar fontes configuradas (${sourcesRes.error.code ?? "db_error"})`,
    );
  }
  if (orgRes.error) {
    throw new Error(
      `tenant_quota_settings_read_failed: falha ao consultar configurações da organização (${orgRes.error.code ?? "db_error"})`,
    );
  }
  if (totalOppRes.error) {
    throw new Error(
      `tenant_quota_records_read_failed: falha ao consultar total de oportunidades (${totalOppRes.error.code ?? "db_error"})`,
    );
  }
  if (monthOppRes.error) {
    throw new Error(
      `tenant_quota_usage_read_failed: falha ao consultar consumo mensal de oportunidades (${monthOppRes.error.code ?? "db_error"})`,
    );
  }
  if (todayRunsRes.error) {
    throw new Error(
      `tenant_quota_sweeps_read_failed: falha ao consultar histórico recente de varreduras (${todayRunsRes.error.code ?? "db_error"})`,
    );
  }

  const sourcesList = sourcesRes.data ?? [];
  const currentActiveSources = sourcesList.filter((s) => s.is_active).length;
  const totalRegisteredSources = sourcesList.length;

  const rawSettings = (orgRes.data?.settings as Record<string, unknown> | null) ?? {};
  const oppSettings = (rawSettings.opportunity_ai as Record<string, unknown> | null) ?? {};

  const maxActiveSources =
    typeof oppSettings.max_active_sources === "number" && oppSettings.max_active_sources > 0
      ? oppSettings.max_active_sources
      : DEFAULT_MAX_ACTIVE_SOURCES;

  const monthlyLimit =
    typeof oppSettings.monthly_limit === "number" && oppSettings.monthly_limit > 0
      ? oppSettings.monthly_limit
      : DEFAULT_MONTHLY_OPPORTUNITY_LIMIT;

  const tokenBucketCapacity =
    typeof oppSettings.token_bucket_capacity === "number" && oppSettings.token_bucket_capacity > 0
      ? oppSettings.token_bucket_capacity
      : DEFAULT_TENANT_SOURCE_QUOTA.capacity;

  const tokenBucketRefillRate =
    typeof oppSettings.token_bucket_refill_rate === "number" &&
    oppSettings.token_bucket_refill_rate > 0
      ? oppSettings.token_bucket_refill_rate
      : DEFAULT_TENANT_SOURCE_QUOTA.refillRatePerMinute;

  const totalRecords = totalOppRes.count ?? 0;
  const createdThisMonth = monthOppRes.count ?? 0;
  const sweepsToday = todayRunsRes.count ?? 0;

  return {
    organization_id: organizationId,
    sources: {
      max_active: maxActiveSources,
      current_active: currentActiveSources,
      total_registered: totalRegisteredSources,
      can_activate_more: currentActiveSources < maxActiveSources,
    },
    opportunities: {
      monthly_limit: monthlyLimit,
      created_this_month: createdThisMonth,
      remaining_this_month: Math.max(0, monthlyLimit - createdThisMonth),
      total_records: totalRecords,
    },
    sweeps: {
      max_records_per_run_ceiling: MAX_RECORDS_PER_RUN_CEILING,
      sweeps_today: sweepsToday,
    },
    rate_limits: {
      intake_per_minute: OPPORTUNITY_MUTATION_LIMITS.intake,
      action_review_per_minute: OPPORTUNITY_MUTATION_LIMITS.action_review,
      outcome_per_minute: OPPORTUNITY_MUTATION_LIMITS.outcome,
      window_seconds: OPPORTUNITY_MUTATION_WINDOW_SECONDS,
    },
    token_bucket: {
      capacity: tokenBucketCapacity,
      refill_rate_per_minute: tokenBucketRefillRate,
    },
    governance: {
      copilot_mode: true,
      outbound_status: "blocked",
    },
  };
}

export async function loadOpportunitySourceViews(
  client: SupabaseClient,
  organizationId: string,
): Promise<{ sources: OpportunitySourceView[]; quota: TenantOpportunityQuota }> {
  const SOURCE_COLUMNS =
    "id, organization_id, source_id, name, source_kind, feed_url, terms_url, regions, niche, offer_key, rate_limit_per_minute, max_records_per_run, is_active, last_synced_at, last_error, created_at, updated_at";

  const [sourcesResult, runsResult, quota] = await Promise.all([
    client
      .from("opportunity_source_configs")
      .select(SOURCE_COLUMNS)
      .eq("organization_id", organizationId)
      .order("updated_at", { ascending: false }),
    client
      .from("opportunity_discovery_runs")
      .select(
        "id, source_id, source_config_id, window_key, status, candidates_seen, opportunities_created, errors, started_at, finished_at",
      )
      .eq("organization_id", organizationId)
      .order("started_at", { ascending: false })
      .limit(100),
    getTenantOpportunityQuota(client, organizationId),
  ]);

  if (sourcesResult.error) {
    throw new Error(`opportunity_sources_read_failed: ${sourcesResult.error.message}`);
  }
  if (runsResult.error) {
    throw new Error(`opportunity_runs_read_failed: ${runsResult.error.message}`);
  }

  const rawSources = sourcesResult.data ?? [];
  const rawRuns = runsResult.data ?? [];

  // Group latest run by source_id
  const latestRunBySourceId = new Map<string, (typeof rawRuns)[number]>();
  for (const run of rawRuns) {
    if (!latestRunBySourceId.has(run.source_id)) {
      latestRunBySourceId.set(run.source_id, run);
    }
  }

  const sources: OpportunitySourceView[] = rawSources.map((source) => {
    const latestRun = latestRunBySourceId.get(source.source_id) ?? null;
    const status = deriveSourceStatus(source, latestRun);

    const lastExecution: OpportunitySourceRunView | null = latestRun
      ? {
          run_id: latestRun.id,
          window_key: latestRun.window_key,
          status: latestRun.status as OpportunitySourceRunView["status"],
          candidates_seen: latestRun.candidates_seen,
          opportunities_created: latestRun.opportunities_created,
          errors: Array.isArray(latestRun.errors)
            ? (latestRun.errors as Array<{ message: string; code?: string }>)
            : [],
          started_at: latestRun.started_at,
          finished_at: latestRun.finished_at,
        }
      : null;

    const resolvedLastError =
      source.last_error ??
      (Array.isArray(latestRun?.errors) && latestRun.errors.length > 0
        ? String(
            (latestRun.errors[0] as { message?: string })?.message ?? "Erro na execução da fonte",
          )
        : null);

    return {
      id: source.id,
      organization_id: source.organization_id,
      source_id: source.source_id,
      name: source.name,
      source_kind: source.source_kind as OpportunitySourceView["source_kind"],
      feed_url: source.feed_url,
      terms_url: source.terms_url,
      regions: source.regions,
      niche: source.niche,
      offer_key: source.offer_key,
      rate_limit_per_minute: source.rate_limit_per_minute,
      max_records_per_run: source.max_records_per_run,
      is_active: source.is_active,
      status,
      last_synced_at: source.last_synced_at ?? latestRun?.finished_at ?? null,
      last_error: resolvedLastError,
      last_execution: lastExecution,
      created_at: source.created_at,
      updated_at: source.updated_at,
    };
  });

  return { sources, quota };
}

export async function loadSingleOpportunitySourceView(
  client: SupabaseClient,
  organizationId: string,
  sourceConfigId: string,
): Promise<{
  source: OpportunitySourceView;
  recent_runs: OpportunitySourceRunView[];
  quota: TenantOpportunityQuota;
} | null> {
  const SOURCE_COLUMNS =
    "id, organization_id, source_id, name, source_kind, feed_url, terms_url, regions, niche, offer_key, rate_limit_per_minute, max_records_per_run, is_active, last_synced_at, last_error, created_at, updated_at";

  const [sourceResult, runsResult, quota] = await Promise.all([
    client
      .from("opportunity_source_configs")
      .select(SOURCE_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("id", sourceConfigId)
      .maybeSingle(),
    client
      .from("opportunity_discovery_runs")
      .select(
        "id, source_id, source_config_id, window_key, status, candidates_seen, opportunities_created, errors, started_at, finished_at",
      )
      .eq("organization_id", organizationId)
      .eq("source_config_id", sourceConfigId)
      .order("started_at", { ascending: false })
      .limit(20),
    getTenantOpportunityQuota(client, organizationId),
  ]);

  if (sourceResult.error) {
    throw new Error(`opportunity_source_read_failed: ${sourceResult.error.message}`);
  }
  if (!sourceResult.data) return null;
  if (runsResult.error) {
    throw new Error(`opportunity_runs_read_failed: ${runsResult.error.message}`);
  }

  const source = sourceResult.data;
  const runs = runsResult.data ?? [];
  const latestRun = runs[0] ?? null;
  const status = deriveSourceStatus(source, latestRun);

  const recentRuns: OpportunitySourceRunView[] = runs.map((run) => ({
    run_id: run.id,
    window_key: run.window_key,
    status: run.status as OpportunitySourceRunView["status"],
    candidates_seen: run.candidates_seen,
    opportunities_created: run.opportunities_created,
    errors: Array.isArray(run.errors)
      ? (run.errors as Array<{ message: string; code?: string }>)
      : [],
    started_at: run.started_at,
    finished_at: run.finished_at,
  }));

  const lastExecution = recentRuns[0] ?? null;
  const resolvedLastError =
    source.last_error ??
    (lastExecution?.errors?.length
      ? String(lastExecution.errors[0]?.message ?? "Erro na execução da fonte")
      : null);

  return {
    source: {
      id: source.id,
      organization_id: source.organization_id,
      source_id: source.source_id,
      name: source.name,
      source_kind: source.source_kind as OpportunitySourceView["source_kind"],
      feed_url: source.feed_url,
      terms_url: source.terms_url,
      regions: source.regions,
      niche: source.niche,
      offer_key: source.offer_key,
      rate_limit_per_minute: source.rate_limit_per_minute,
      max_records_per_run: source.max_records_per_run,
      is_active: source.is_active,
      status,
      last_synced_at: source.last_synced_at ?? lastExecution?.finished_at ?? null,
      last_error: resolvedLastError,
      last_execution: lastExecution,
      created_at: source.created_at,
      updated_at: source.updated_at,
    },
    recent_runs: recentRuns,
    quota,
  };
}

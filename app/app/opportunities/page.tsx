import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { loadOpportunityRadar } from "@/lib/opportunity-intelligence/read";
import { loadOpportunitySourceViews } from "@/lib/opportunity-intelligence/quotas";
import { OpportunityRadar } from "./_components/OpportunityRadar";
import { TenantQuotaBar } from "./_components/TenantQuotaBar";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Oportunidades" };

export default async function OpportunitiesPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const client = await createClient();
  const [rows, sourceData] = await Promise.all([
    loadOpportunityRadar(client, activeOrg.orgId),
    loadOpportunitySourceViews(client, activeOrg.orgId).catch(() => ({
      sources: [],
      quota: null,
    })),
  ]);

  const quota = sourceData.quota;

  return (
    <div className="flex h-full flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium tracking-[0.16em] text-accent uppercase">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            Inteligência comercial
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Radar de oportunidades</h1>
          <p className="mt-1 max-w-2xl text-sm text-text-muted">
            Descobertas explicáveis: cada oportunidade mostra o sinal, a fonte, o frescor e o
            próximo passo antes de chegar até você.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs text-text-muted">
            Organização ativa · {activeOrg.role}
          </div>
          <TenantQuotaBar
            tokens={quota ? quota.opportunities.remaining_this_month : 100}
            capacity={quota ? quota.opportunities.monthly_limit : 100}
            refillRatePerMinute={quota ? quota.rate_limits.intake_per_minute : 10}
            className="w-full sm:w-72"
          />
        </div>
      </header>
      <OpportunityRadar
        rows={rows}
        nowIso={new Date().toISOString()}
        initialSources={sourceData.sources}
        initialQuota={quota}
      />
    </div>
  );
}

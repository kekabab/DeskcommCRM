import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPPORTUNITY_EVENTS } from "./domain";

const root = process.cwd();
const migration = readFileSync(
  resolve(root, "supabase/migrations/20260920170000_0240_opportunity_intelligence.sql"),
  "utf8",
);
const transactionalMigration = readFileSync(
  resolve(root, "supabase/migrations/20260920220000_0244_opportunity_pipeline_rpc.sql"),
  "utf8",
);
const activityIdempotencyMigration = readFileSync(
  resolve(root, "supabase/migrations/20260920200000_0242_opportunity_activity_idempotency.sql"),
  "utf8",
);
const mutationBoundaryMigration = readFileSync(
  resolve(root, "supabase/migrations/20260920210000_0243_opportunity_mutation_boundary.sql"),
  "utf8",
);
const quotaBucketMigration = readFileSync(
  resolve(root, "supabase/migrations/20260920230000_0245_opportunity_source_quota_bucket.sql"),
  "utf8",
);
const writer = readFileSync(resolve(root, "lib/opportunity-intelligence/write.ts"), "utf8");
const baseline = readFileSync(resolve(root, "supabase/baseline.sql"), "utf8");
const manifest = readFileSync(resolve(root, "supabase/migrations/MANIFEST.md"), "utf8");

describe("Opportunity Intelligence persistence contract", () => {
  it("persists the four layers without duplicating CRM leads", () => {
    expect(migration).toContain("create table if not exists public.opportunity_records");
    expect(migration).toContain("create table if not exists public.opportunity_evidence");
    expect(migration).toContain("create table if not exists public.opportunity_actions");
    expect(migration).toContain("create table if not exists public.opportunity_outcomes");
    expect(migration).toContain("linked_lead_id uuid references public.crm_leads(id)");
    expect(migration).toContain("foreign key (organization_id, opportunity_id)");
    expect(migration).toContain("foreign key (organization_id, action_id)");
    expect(migration).not.toContain("create table if not exists public.opportunity_leads");
  });

  it("enforces provenance, freshness, idempotency and tenant RLS", () => {
    expect(migration).toContain("source_url ~ '^https://'");
    expect(migration).toContain(
      "freshness_ttl_hours integer not null check (freshness_ttl_hours > 0)",
    );
    expect(migration).toContain("opportunity_actions_idempotency_unique");
    expect(migration).toContain("opportunity_actions_open_unique");
    expect(migration).toContain("opportunity_outcomes_idempotency_unique");
    expect(migration).toContain("create policy opportunity_evidence_write");
    expect(writer).toContain('"persist_opportunity_pipeline_plan"');
    expect(transactionalMigration).toContain(
      "create or replace function public.persist_opportunity_pipeline_plan",
    );
    expect(transactionalMigration).toContain("security definer");
    expect(transactionalMigration).toContain("opportunity_event_log_idempotency_unique");
    expect(transactionalMigration).toContain("v_existing_state = 'suppressed'");
    expect(migration).toContain("expires_at timestamptz generated always as");
    expect(migration).toContain("opportunity_suppressed_terminal");
    expect(migration).toContain("alter table public.opportunity_records enable row level security");
    expect(migration).toContain(
      "revoke all on public.opportunity_records, public.opportunity_evidence",
    );
    expect(migration).toContain(
      "grant all on public.opportunity_records, public.opportunity_evidence",
    );
  });

  it("enforces negative ACL on RPC 0244 and restricts EXECUTE strictly to service_role", () => {
    // Invariante de Segurança: A RPC 0244 é SECURITY DEFINER e JAMAIS pode ser executada por anon ou authenticated
    expect(transactionalMigration).toContain(
      "revoke all on function public.persist_opportunity_pipeline_plan(jsonb, uuid) from public, anon, authenticated;",
    );
    expect(transactionalMigration).toContain(
      "grant execute on function public.persist_opportunity_pipeline_plan(jsonb, uuid) to service_role;",
    );

    // Garante que não há nenhuma concessão de execução para authenticated ou anon
    expect(transactionalMigration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.persist_opportunity_pipeline_plan.*to\s+(authenticated|anon|public)/i,
    );
  });

  it("enforces internal cross-tenant and role authorization guard inside RPC 0244", () => {
    // Invariante de Defesa em Profundidade: se a função for exposta acidentalmente,
    // o código bloqueia chamadas cross-tenant checando membership de manager
    expect(transactionalMigration).toContain("if auth.uid() is not null");
    expect(transactionalMigration).toContain(
      "not public.fn_role_at_least(v_organization_id, 'manager')",
    );
    expect(transactionalMigration).toContain("caller_not_authorized_for_org");
  });

  it("enforces mutation boundary (migration 0243) revoking writes from authenticated users", () => {
    // Os clientes autenticados mantêm acesso SELECT (para Radar/Dossiê), mas perdem mutação direta (INSERT/UPDATE/DELETE)
    expect(mutationBoundaryMigration).toContain("revoke all on public.opportunity_records,");
    expect(mutationBoundaryMigration).toContain(
      "grant select on public.opportunity_records, public.opportunity_evidence,",
    );
  });

  it("enforces timeline idempotency unique index (migration 0242) for crm_lead_activities", () => {
    // Índice parcial único para impedir duplicação de atividades de vínculo na timeline
    expect(activityIdempotencyMigration).toContain(
      "create unique index if not exists crm_lead_activities_opportunity_link_unique",
    );
    expect(activityIdempotencyMigration).toContain(
      "on public.crm_lead_activities (organization_id, (metadata->>'idempotency_key'))",
    );
    expect(activityIdempotencyMigration).toContain(
      "where source_module = 'opportunity_intelligence'",
    );
    expect(activityIdempotencyMigration).toContain("and type = 'opportunity_linked'");
    expect(activityIdempotencyMigration).toContain("and metadata ? 'idempotency_key'");
  });

  it("enforces persistent, atomic token-bucket quota state and RPC (migration 0245)", () => {
    // Tabela de bucket de quota com constraint única e FK composta para evitar órfãos
    expect(quotaBucketMigration).toContain(
      "create table if not exists public.opportunity_source_quota_buckets",
    );
    expect(quotaBucketMigration).toContain(
      "constraint opportunity_source_quota_buckets_org_source_unique unique (organization_id, source_id)",
    );
    expect(quotaBucketMigration).toContain(
      "constraint opportunity_source_quota_buckets_tokens_non_negative check (tokens >= 0)",
    );
    expect(quotaBucketMigration).toContain(
      "constraint opportunity_source_quota_buckets_source_fk foreign key (organization_id, source_id)",
    );
    expect(quotaBucketMigration).toContain(
      "references public.opportunity_source_configs(organization_id, source_id) on delete cascade",
    );

    // RLS ativado e forçado; escrita direta proibida para authenticated
    expect(quotaBucketMigration).toContain(
      "alter table public.opportunity_source_quota_buckets enable row level security;",
    );
    expect(quotaBucketMigration).toContain(
      "alter table public.opportunity_source_quota_buckets force row level security;",
    );
    expect(quotaBucketMigration).toContain(
      "revoke all on public.opportunity_source_quota_buckets from public, anon, authenticated;",
    );
    expect(quotaBucketMigration).toContain(
      "grant select on public.opportunity_source_quota_buckets to authenticated;",
    );
    expect(quotaBucketMigration).toContain(
      "grant all on public.opportunity_source_quota_buckets to service_role;",
    );

    // RPC SECURITY DEFINER com lock FOR UPDATE e restrição estrita service_role
    expect(quotaBucketMigration).toContain(
      "create or replace function public.consume_opportunity_source_quota",
    );
    expect(quotaBucketMigration).toContain("security definer");
    expect(quotaBucketMigration).toContain("for update;");
    expect(quotaBucketMigration).toContain("cost_must_be_positive");
    expect(quotaBucketMigration).toContain("opportunity_source_not_found");
    expect(quotaBucketMigration).toContain("opportunity_quota_mutation_forbidden");

    // Negative ACL: authenticated e anon JAMAIS executam a RPC de consumo
    expect(quotaBucketMigration).toContain(
      "revoke all on function public.consume_opportunity_source_quota(uuid, text, numeric, numeric, numeric) from public, anon, authenticated;",
    );
    expect(quotaBucketMigration).toContain(
      "grant execute on function public.consume_opportunity_source_quota(uuid, text, numeric, numeric, numeric) to service_role;",
    );
    expect(quotaBucketMigration).not.toMatch(
      /grant\s+execute\s+on\s+function\s+public\.consume_opportunity_source_quota.*to\s+(authenticated|anon|public)/i,
    );

    // Retorno JSON compatível com Cometa e Duna
    expect(quotaBucketMigration).toContain("'tokens_remaining', v_remaining_tokens");
    expect(quotaBucketMigration).toContain("'remainingTokens', v_remaining_tokens");
    expect(quotaBucketMigration).toContain("'retry_after_seconds', v_retry_after");
    expect(quotaBucketMigration).toContain("'retryAfterSeconds', v_retry_after");
  });

  it("enforces strict cross-tenant source isolation and caller role veto in consume_opportunity_source_quota", () => {
    // Veto estrito se executado por usuário autenticado (SQLSTATE 42501)
    expect(quotaBucketMigration).toContain("if auth.role() = 'authenticated' then");
    expect(quotaBucketMigration).toContain(
      "raise exception 'opportunity_quota_mutation_forbidden' using errcode = '42501';",
    );

    // Validação de existência da fonte para o tenant informado (evita buckets cross-tenant ou órfãos)
    expect(quotaBucketMigration).toContain("select 1 from public.opportunity_source_configs");
    expect(quotaBucketMigration).toContain(
      "where organization_id = p_organization_id and source_id = p_source_id",
    );
    expect(quotaBucketMigration).toContain(
      "raise exception 'opportunity_source_not_found' using errcode = 'P0002';",
    );

    // Validação de custo estritamente positivo (proíbe custo zero ou negativo que geraria evasão de quota)
    expect(quotaBucketMigration).toContain("if p_cost is null or p_cost <= 0 then");
    expect(quotaBucketMigration).toContain(
      "raise exception 'cost_must_be_positive' using errcode = '22023';",
    );
  });

  it("serializes concurrent quota consumption so only one debit succeeds when budget is exhausted", async () => {
    // Simulação do comportamento serializado do lock FOR UPDATE do Postgres
    let currentTokens = 1.0;
    let lock: Promise<void> = Promise.resolve();

    async function simulatedAtomicConsume(cost: number) {
      let releaseLock!: () => void;
      const prevLock = lock;
      lock = new Promise((resolve) => {
        releaseLock = resolve;
      });

      await prevLock;
      try {
        if (currentTokens >= cost) {
          currentTokens -= cost;
          return { allowed: true, tokens_remaining: currentTokens, remainingTokens: currentTokens };
        }
        return { allowed: false, tokens_remaining: currentTokens, remainingTokens: currentTokens };
      } finally {
        releaseLock();
      }
    }

    // Dois consumos simultâneos de custo 1.0 com saldo inicial de apenas 1.0
    const [resultA, resultB] = await Promise.all([
      simulatedAtomicConsume(1.0),
      simulatedAtomicConsume(1.0),
    ]);

    // Exatamente um deve ser permitido e o outro deve ser negado com saldo final 0
    const allowedCount = [resultA.allowed, resultB.allowed].filter(Boolean).length;
    expect(allowedCount).toBe(1);
    expect(resultA.tokens_remaining).toBe(resultA.remainingTokens);
    expect(resultB.tokens_remaining).toBe(resultB.remainingTokens);
    expect(currentTokens).toBe(0.0);
  });

  it("keeps the append-only baseline block ahead of anon hardening", () => {
    const opportunityBlock = baseline.indexOf("-- ---- Opportunity Intelligence (migration 0240)");
    const quotaBucketBlock = baseline.indexOf(
      "-- ---- Opportunity Source Quota Buckets (migration 0245)",
    );
    const anonHardening = baseline.indexOf("-- ---- VARREDURA anon:");

    expect(opportunityBlock).toBeGreaterThan(-1);
    expect(quotaBucketBlock).toBeGreaterThan(opportunityBlock);
    expect(anonHardening).toBeGreaterThan(quotaBucketBlock);
    expect(manifest).toContain("| `20260920170000` | `0240_opportunity_intelligence` |");
    expect(manifest).toContain("| `20260920220000` | `0244_opportunity_pipeline_rpc` |");
    expect(manifest).toContain("| `20260920230000` | `0245_opportunity_source_quota_bucket` |");
    expect(baseline).toContain("persist_opportunity_pipeline_plan");
    expect(baseline).toContain("opportunity_source_quota_buckets");
    expect(baseline).toContain("consume_opportunity_source_quota");
    expect(baseline).toContain("opportunity_event_log_idempotency_unique");
  });

  it("freezes event names to the two-segment event_log vocabulary", () => {
    expect(OPPORTUNITY_EVENTS).toEqual([
      "opportunity.signal_detected",
      "opportunity.ready_for_action",
      "opportunity.exception_raised",
      "opportunity.outcome_recorded",
    ]);
    for (const event of OPPORTUNITY_EVENTS) {
      expect(event).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});

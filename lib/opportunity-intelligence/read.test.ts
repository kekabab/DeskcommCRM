import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadOpportunityRadar, loadOpportunityDossier } from "@/lib/opportunity-intelligence/read";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const OPP_ID_1 = "33333333-3333-4333-8333-333333333331";
const OPP_ID_2 = "33333333-3333-4333-8333-333333333332";

type MockRow = Record<string, unknown>;

function createMockSupabase(dataset: {
  opportunity_records?: MockRow[];
  opportunity_evidence?: MockRow[];
  opportunity_actions?: MockRow[];
  opportunity_outcomes?: MockRow[];
}) {
  const tables = {
    opportunity_records: dataset.opportunity_records ?? [],
    opportunity_evidence: dataset.opportunity_evidence ?? [],
    opportunity_actions: dataset.opportunity_actions ?? [],
    opportunity_outcomes: dataset.opportunity_outcomes ?? [],
  };

  const client = {
    from: vi.fn((tableName: keyof typeof tables) => {
      const rows = tables[tableName] ?? [];
      const filters: Record<string, unknown> = {};
      let inFilter: { col: string; vals: unknown[] } | null = null;

      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((col: string, val: unknown) => {
          filters[col] = val;
          return query;
        }),
        in: vi.fn((col: string, vals: unknown[]) => {
          inFilter = { col, vals };
          return query;
        }),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => {
          const match = rows.find((r) => {
            for (const [k, v] of Object.entries(filters)) {
              if (r[k] !== v) return false;
            }
            return true;
          });
          return { data: match ?? null, error: null };
        }),
        then: undefined as unknown,
      };

      // When awaited as a list query
      Object.assign(query, {
        then: (resolve: (val: { data: MockRow[]; error: null }) => void) => {
          const filtered = rows.filter((r) => {
            for (const [k, v] of Object.entries(filters)) {
              if (r[k] !== v) return false;
            }
            if (inFilter && !inFilter.vals.includes(r[inFilter.col])) {
              return false;
            }
            return true;
          });
          resolve({ data: filtered, error: null });
        },
      });

      return query;
    }),
  };

  return client as unknown as SupabaseClient;
}

describe("read.ts - Opportunity Projections", () => {
  describe("loadOpportunityRadar", () => {
    it("retorna array vazio quando não há registros para a organização", async () => {
      const client = createMockSupabase({});
      const result = await loadOpportunityRadar(client, ORG_A);
      expect(result).toEqual([]);
    });

    it("isola registros por organização e associa evidências e ação mais recente", async () => {
      const records: MockRow[] = [
        {
          id: OPP_ID_1,
          organization_id: ORG_A,
          identity_key: "org-a-candidate",
          display_name: "Empresa Alfa",
          state: "action_ready",
          confidence: 0.9,
          signals: [],
          updated_at: "2026-09-20T16:00:00Z",
        },
        {
          id: OPP_ID_2,
          organization_id: ORG_B,
          identity_key: "org-b-candidate",
          display_name: "Empresa Beta",
          state: "awaiting_human",
          confidence: 0.95,
          signals: [],
          updated_at: "2026-09-20T16:00:00Z",
        },
      ];

      const evidence: MockRow[] = [
        {
          id: "ev-1",
          organization_id: ORG_A,
          opportunity_id: OPP_ID_1,
          evidence_key: "ev-site-speed",
          source_id: "pagespeed",
          source_url: "https://pagespeed.web.dev/analysis",
          terms_url: "https://developers.google.com/terms",
          policy_status: "verified",
          claim: "Site lento no mobile (FCP > 3.5s)",
          confidence: 0.9,
          collected_at: "2026-09-20T15:00:00Z",
          expires_at: "2026-09-27T15:00:00Z",
        },
      ];

      const actions: MockRow[] = [
        {
          id: "act-1",
          organization_id: ORG_A,
          opportunity_id: OPP_ID_1,
          action: "prepare_personalized_draft",
          status: "proposed",
          requires_human_approval: true,
          pain_hypothesis: "Perda de clientes por lentidão no mobile",
          target_offer: "Otimização de performance de e-commerce",
          proof_asset_summary: "Mini diagnóstico de 3 telas com métricas Core Web Vitals",
          evidence_keys: ["ev-site-speed"],
          reason: "Confiança alta e sinais verificados",
          created_at: "2026-09-20T15:30:00Z",
        },
      ];

      const client = createMockSupabase({
        opportunity_records: records,
        opportunity_evidence: evidence,
        opportunity_actions: actions,
      });

      const radarA = await loadOpportunityRadar(client, ORG_A);
      expect(radarA).toHaveLength(1);
      expect(radarA[0]!.id).toBe(OPP_ID_1);
      expect(radarA[0]!.display_name).toBe("Empresa Alfa");
      expect(radarA[0]!.evidence).toHaveLength(1);
      expect(radarA[0]!.latest_action?.action).toBe("prepare_personalized_draft");

      const radarB = await loadOpportunityRadar(client, ORG_B);
      expect(radarB).toHaveLength(1);
      expect(radarB[0]!.id).toBe(OPP_ID_2);
      expect(radarB[0]!.display_name).toBe("Empresa Beta");
      expect(radarB[0]!.evidence).toHaveLength(0);
      expect(radarB[0]!.latest_action).toBeNull();
    });
  });

  describe("loadOpportunityDossier", () => {
    it("retorna null se a oportunidade não existe ou é de outra organização", async () => {
      const client = createMockSupabase({
        opportunity_records: [
          {
            id: OPP_ID_1,
            organization_id: ORG_B,
            identity_key: "org-b-candidate",
            state: "action_ready",
          },
        ],
      });

      const dossier = await loadOpportunityDossier(client, ORG_A, OPP_ID_1);
      expect(dossier).toBeNull();
    });

    it("monta a estrutura canônica FACT (Fato, Âncora, Consequência, Prova Tangível)", async () => {
      const records: MockRow[] = [
        {
          id: OPP_ID_1,
          organization_id: ORG_A,
          identity_key: "org-a-empresa",
          display_name: "Agência Digital Alfa",
          domain: "agenciadigitalalfa.com.br",
          state: "awaiting_human",
          confidence: 0.92,
          signals: [
            { key: "unoptimized_landing_page", label: "Landing page sem conversão mobile" },
          ],
          exception_code: "tenant_requires_approval",
          exception_message: "Tenant em modo Copiloto requer aprovação humana",
          created_at: "2026-09-20T10:00:00Z",
          updated_at: "2026-09-20T12:00:00Z",
        },
      ];

      const evidence: MockRow[] = [
        {
          id: "ev-1",
          organization_id: ORG_A,
          opportunity_id: OPP_ID_1,
          evidence_key: "ev-lighthouse",
          source_id: "google-pagespeed",
          source_url: "https://pagespeed.web.dev/analysis",
          terms_url: "https://developers.google.com/terms",
          policy_status: "verified",
          claim: "Pontuação mobile 34/100, FCP 4.2s",
          confidence: 0.95,
          collected_at: "2026-09-20T10:00:00Z",
          expires_at: "2026-09-27T10:00:00Z",
        },
      ];

      const actions: MockRow[] = [
        {
          id: "act-1",
          organization_id: ORG_A,
          opportunity_id: OPP_ID_1,
          action: "prepare_personalized_draft",
          status: "proposed",
          requires_human_approval: true,
          pain_hypothesis: "Perda estimada de 40% do tráfego pago por lentidão no checkout móvel",
          target_offer: "Diagnóstico técnico de performance + proposta de revamp",
          proof_asset_summary: "Relatório comparativo de velocidade vs concorrentes locais",
          evidence_keys: ["ev-lighthouse"],
          reason: "Sinal comprovado e sem lead ativo existente",
          created_at: "2026-09-20T11:00:00Z",
        },
      ];

      const outcomes: MockRow[] = [
        {
          id: "out-1",
          organization_id: ORG_A,
          opportunity_id: OPP_ID_1,
          action_id: "act-1",
          idempotency_key: "idemp-out-1",
          kind: "reply",
          reason: "Cliente respondeu querendo ver o comparativo",
          occurred_at: "2026-09-20T12:00:00Z",
          metrics: { response_time_minutes: 15 },
          created_at: "2026-09-20T12:05:00Z",
        },
      ];

      const client = createMockSupabase({
        opportunity_records: records,
        opportunity_evidence: evidence,
        opportunity_actions: actions,
        opportunity_outcomes: outcomes,
      });

      const dossier = await loadOpportunityDossier(client, ORG_A, OPP_ID_1, "2026-09-20T13:00:00Z");

      expect(dossier).not.toBeNull();
      if (!dossier) return;

      // F: Fato
      expect(dossier.fact.facts).toHaveLength(1);
      expect(dossier.fact.facts[0]!.claim).toBe("Pontuação mobile 34/100, FCP 4.2s");
      expect(dossier.fact.facts[0]!.confidence).toBe(0.95);

      // A: Âncora & Frescor
      expect(dossier.fact.anchors).toHaveLength(1);
      expect(dossier.fact.anchors[0]!.source_id).toBe("google-pagespeed");
      expect(dossier.fact.anchors[0]!.is_expired).toBe(false);

      // C: Consequência
      expect(dossier.fact.consequence.pain_hypothesis).toContain("Perda estimada de 40%");

      // T: Prova Tangível
      expect(dossier.fact.tangible_proof.target_offer).toBe(
        "Diagnóstico técnico de performance + proposta de revamp",
      );
      expect(dossier.fact.tangible_proof.proof_asset_summary).toBe(
        "Relatório comparativo de velocidade vs concorrentes locais",
      );

      // Histórico de Outcomes
      expect(dossier.outcomes).toHaveLength(1);
      expect(dossier.outcomes[0]!.kind).toBe("reply");
    });
  });
});

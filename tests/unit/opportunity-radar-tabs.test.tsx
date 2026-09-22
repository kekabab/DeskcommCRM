import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpportunityRadar } from "@/app/app/opportunities/_components/OpportunityRadar";
import { OpportunityExceptionsQueue } from "@/app/app/opportunities/_components/OpportunityExceptionsQueue";
import { OpportunitySourcesManager } from "@/app/app/opportunities/_components/OpportunitySourcesManager";
import type { OpportunityRadarRow } from "@/lib/opportunity-intelligence/read";
import type {
  OpportunitySourceView,
  TenantOpportunityQuota,
} from "@/lib/opportunity-intelligence/quotas";

const mockNowIso = "2026-09-20T20:00:00.000Z";

const mockQuota: TenantOpportunityQuota = {
  organization_id: "00000000-0000-4000-8000-000000000001",
  sources: {
    current_active: 2,
    max_active: 5,
    total_registered: 3,
    can_activate_more: true,
  },
  opportunities: {
    created_this_month: 42,
    monthly_limit: 300,
    remaining_this_month: 258,
    total_records: 120,
  },
  sweeps: {
    sweeps_today: 8,
    max_records_per_run_ceiling: 100,
  },
  rate_limits: {
    intake_per_minute: 60,
    action_review_per_minute: 30,
    outcome_per_minute: 30,
    window_seconds: 60,
  },
  token_bucket: {
    capacity: 100,
    refill_rate_per_minute: 10,
  },
  governance: {
    copilot_mode: true,
    outbound_status: "blocked",
  },
};

const mockSources: OpportunitySourceView[] = [
  {
    id: "cfg-1",
    organization_id: "00000000-0000-4000-8000-000000000001",
    source_id: "places-feed",
    name: "Feed de Estabelecimentos SP",
    source_kind: "open_data",
    feed_url: "https://dados.sp.gov.br/feed.json",
    terms_url: "https://dados.sp.gov.br/termos",
    regions: ["SP", "BR"],
    niche: "varejo",
    offer_key: "recuperacao",
    rate_limit_per_minute: 60,
    max_records_per_run: 50,
    is_active: true,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    last_synced_at: "2026-09-20T19:00:00.000Z",
    last_error: null,
    status: "healthy",
    last_execution: {
      run_id: "run-1",
      window_key: "2026-09-20T19:00:00.000Z",
      started_at: "2026-09-20T19:00:00.000Z",
      finished_at: "2026-09-20T19:01:00.000Z",
      status: "succeeded",
      candidates_seen: 20,
      opportunities_created: 5,
      errors: [],
    },
  },
  {
    id: "cfg-2",
    organization_id: "00000000-0000-4000-8000-000000000001",
    source_id: "cnpj-rfb",
    name: "Diário Oficial Receita",
    source_kind: "open_data",
    feed_url: "https://dados.receita.fazenda.gov.br/feed.json",
    terms_url: "https://dados.receita.fazenda.gov.br/termos",
    regions: ["BR"],
    niche: "geral",
    offer_key: "abertura",
    rate_limit_per_minute: 30,
    max_records_per_run: 20,
    is_active: false,
    created_at: "2026-09-18T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    last_synced_at: "2026-09-20T15:00:00.000Z",
    last_error: "Connection refused by peer",
    status: "inactive",
    last_execution: {
      run_id: "run-0",
      window_key: "2026-09-20T15:00:00.000Z",
      started_at: "2026-09-20T15:00:00.000Z",
      finished_at: "2026-09-20T15:00:10.000Z",
      status: "failed",
      candidates_seen: 0,
      opportunities_created: 0,
      errors: [{ message: "Connection refused by peer" }],
    },
  },
];

const mockRows: OpportunityRadarRow[] = [
  {
    id: "opp-1",
    organization_id: "00000000-0000-4000-8000-000000000001",
    linked_lead_id: null,
    identity_key: "cnpj:12345678000199",
    display_name: "Empresa Alpha Ltda",
    domain: "alphaltda.com.br",
    region_key: "SP",
    state: "action_ready",
    confidence: 0.85,
    signals: [
      {
        key: "abertura_recente",
        label: "Abertura Recente",
        evidence_ids: ["ev-1"],
        priority: "high",
      },
    ],
    exception_code: null,
    exception_message: null,
    last_evaluated_at: "2026-09-20T18:30:00.000Z",
    last_exception_at: null,
    suppressed_at: null,
    suppressed_reason: null,
    created_at: "2026-09-20T18:00:00.000Z",
    updated_at: "2026-09-20T18:30:00.000Z",
    evidence: [
      {
        id: "ev-1",
        opportunity_id: "opp-1",
        evidence_key: "feed-sp:12345678000199",
        source_id: "places-feed",
        source_url: "https://dados.sp.gov.br/feed/12345678000199",
        terms_url: "https://dados.sp.gov.br/termos",
        policy_status: "allowed",
        claim: "Registro de abertura comercial publicado no Diário Oficial de SP",
        confidence: 0.85,
        collected_at: "2026-09-20T18:00:00.000Z",
        expires_at: "2026-09-27T18:00:00.000Z",
      },
    ],
    latest_action: {
      id: "act-1",
      opportunity_id: "opp-1",
      action: "prepare_personalized_draft",
      status: "proposed",
      requires_human_approval: true,
      pain_hypothesis: "Necessidade de estruturação fiscal para nova filial",
      target_offer: "Consultoria Tributária Integrada",
      proof_asset_summary: "Estudo de caso Varejo SP 2026",
      evidence_keys: ["feed-sp:12345678000199"],
      reason: null,
      created_at: "2026-09-20T18:30:00.000Z",
    },
  },
  {
    id: "opp-2",
    organization_id: "00000000-0000-4000-8000-000000000001",
    linked_lead_id: "lead-999",
    identity_key: "cnpj:98765432000188",
    display_name: "Beta Logística S/A",
    domain: "betalog.com.br",
    region_key: "BR",
    state: "awaiting_human",
    confidence: 0.45,
    signals: [
      {
        key: "busca_parceiro",
        label: "Busca de Parceiros",
        evidence_ids: ["ev-2"],
        priority: "medium",
      },
    ],
    exception_code: "existing_active_lead",
    exception_message: "Lead já em andamento no CRM",
    last_evaluated_at: "2026-09-20T17:30:00.000Z",
    last_exception_at: "2026-09-20T17:30:00.000Z",
    suppressed_at: null,
    suppressed_reason: null,
    created_at: "2026-09-20T17:00:00.000Z",
    updated_at: "2026-09-20T17:30:00.000Z",
    evidence: [
      {
        id: "ev-2",
        opportunity_id: "opp-2",
        evidence_key: "cnpj-rfb:98765432000188",
        source_id: "cnpj-rfb",
        source_url: "https://dados.receita.fazenda.gov.br/feed/98765432000188",
        terms_url: "https://dados.receita.fazenda.gov.br/termos",
        policy_status: "allowed",
        claim: "Alteração societária recente em logística",
        confidence: 0.45,
        collected_at: "2026-09-20T17:00:00.000Z",
        expires_at: "2026-09-27T17:00:00.000Z",
      },
    ],
    latest_action: {
      id: "act-2",
      opportunity_id: "opp-2",
      action: "request_human_review",
      status: "proposed",
      requires_human_approval: true,
      pain_hypothesis: "Conflito potencial com atendimento comercial em curso",
      target_offer: null,
      proof_asset_summary: null,
      evidence_keys: ["cnpj-rfb:98765432000188"],
      reason: "Lead já em andamento no CRM",
      created_at: "2026-09-20T17:30:00.000Z",
    },
  },
  {
    id: "opp-3",
    organization_id: "00000000-0000-4000-8000-000000000001",
    linked_lead_id: null,
    identity_key: "cnpj:55555555000155",
    display_name: "Gamma Tech Eireli",
    domain: "gammatech.io",
    region_key: "SP",
    state: "stale",
    confidence: 0.65,
    signals: [
      {
        key: "vaga_aberta",
        label: "Contratação em TI",
        evidence_ids: ["ev-3"],
        priority: "low",
      },
    ],
    exception_code: "stale_evidence",
    exception_message: "Evidência expirou antes do contato",
    last_evaluated_at: "2026-09-18T10:00:00.000Z",
    last_exception_at: "2026-09-18T10:00:00.000Z",
    suppressed_at: null,
    suppressed_reason: null,
    created_at: "2026-09-10T10:00:00.000Z",
    updated_at: "2026-09-15T10:00:00.000Z",
    evidence: [
      {
        id: "ev-3",
        opportunity_id: "opp-3",
        evidence_key: "feed-sp:55555555000155",
        source_id: "places-feed",
        source_url: "https://dados.sp.gov.br/feed/55555555000155",
        terms_url: "https://dados.sp.gov.br/termos",
        policy_status: "allowed",
        claim: "Anúncio de expansão e contratação técnica",
        confidence: 0.65,
        collected_at: "2026-09-10T10:00:00.000Z",
        expires_at: "2026-09-18T10:00:00.000Z",
      },
    ],
    latest_action: {
      id: "act-3",
      opportunity_id: "opp-3",
      action: "refresh_evidence",
      status: "proposed",
      requires_human_approval: true,
      pain_hypothesis: "Necessidade de revalidação de dados cadastrais",
      target_offer: null,
      proof_asset_summary: null,
      evidence_keys: ["feed-sp:55555555000155"],
      reason: "Evidência expirou antes do contato",
      created_at: "2026-09-15T10:00:00.000Z",
    },
  },
];

describe("Opportunity Radar — Componentes, Abas e Governança", () => {
  describe("Navegação de Abas (Tabs Visíveis)", () => {
    it("renderiza as 3 abas obrigatórias com seus respectivos contadores e copilot banner", () => {
      const html = renderToString(
        <OpportunityRadar
          rows={mockRows}
          nowIso={mockNowIso}
          initialSources={mockSources}
          initialQuota={mockQuota}
        />,
      );

      // Abas de navegação presentes com data-testid
      expect(html).toContain('data-testid="tab-radar"');
      expect(html).toContain('data-testid="tab-exceptions"');
      expect(html).toContain('data-testid="tab-sources"');

      // Títulos das abas
      expect(html).toContain("Radar de Oportunidades");
      expect(html).toContain("Fila de Exceções");
      expect(html).toContain("Gestão de Fontes &amp; Quotas");

      // Badges numéricos com contagens alinhadas
      expect(html).toContain(">3<"); // 3 itens no radar
      expect(html).toContain(">2<"); // 2 exceções (opp-2 awaiting_human + opp-3 stale)

      // Invariante de Segurança: Banner do Modo Copiloto
      expect(html).toContain("Modo Copiloto:");
      expect(html).toContain("nada é enviado automaticamente");
    });
  });

  describe("Fila de Exceções (OpportunityExceptionsQueue)", () => {
    it("exibe lista de exceções com diagnóstico, confiança e link de lead no CRM", () => {
      const html = renderToString(
        <OpportunityExceptionsQueue
          items={mockRows}
          nowIso={mockNowIso}
          onOpenDossier={() => {}}
          onActionReviewed={() => {}}
        />,
      );

      expect(html).toContain('data-testid="exceptions-queue"');
      expect(html).toContain("Beta Logística S/A");
      expect(html).toContain("Lead já em andamento no CRM");
      expect(html).toContain("45%");

      // Link para o CRM quando houver lead vinculado
      expect(html).toContain('data-testid="exception-linked-lead-link"');
      expect(html).toContain('href="/app/leads/lead-999"');

      // Botão de inspecionar dossiê
      expect(html).toContain('data-testid="open-dossier-btn"');
      expect(html).toContain("Inspecionar Dossiê FACT");

      // Controles de resolução propostos
      expect(html).toContain('data-testid="exception-approve-btn"');
      expect(html).toContain('data-testid="exception-reject-btn"');
    });

    it("exibe estado vazio amigável quando nenhuma exceção existe", () => {
      const html = renderToString(
        <OpportunityExceptionsQueue
          items={[]}
          nowIso={mockNowIso}
          onOpenDossier={() => {}}
          onActionReviewed={() => {}}
        />,
      );

      expect(html).toContain('data-testid="exceptions-empty"');
      expect(html).toContain("Nenhuma exceção retida nesta categoria");
    });
  });

  describe("Gestão de Fontes & Quotas (OpportunitySourcesManager)", () => {
    it("garante que nenhum segredo, chave privada ou token é exposto no HTML", () => {
      const html = renderToString(
        <OpportunitySourcesManager initialSources={mockSources} initialQuota={mockQuota} />,
      );

      // Invariante de Segurança: Segredos NUNCA aparecem no HTML renderizado
      const lower = html.toLowerCase();
      expect(lower).not.toContain("service_role");
      expect(lower).not.toContain("supabase_key");
      expect(lower).not.toContain("bearer ");
      expect(lower).not.toContain("secret_key");
      expect(lower).not.toContain("password");
      expect(lower).not.toContain("private_key");

      // Banner explícito de Governança
      expect(html).toContain("Governança de Fontes:");
      expect(html).toContain("Segredos e credenciais NUNCA são expostos");
      expect(html).toContain("outbound permanece 100% blindado");
    });

    it("renderiza fontes cadastradas com botões de testar e pausar/reativar", () => {
      const html = renderToString(
        <OpportunitySourcesManager initialSources={mockSources} initialQuota={mockQuota} />,
      );

      expect(html).toContain('data-testid="sources-manager"');
      expect(html).toContain("Feed de Estabelecimentos SP");
      expect(html).toContain("Diário Oficial Receita");

      // Botões de operação
      expect(html).toContain('data-testid="test-source-btn"');
      expect(html).toContain('data-testid="toggle-source-btn"');

      // Sanitização de erros em fontes inativas/falhas
      expect(html).toContain("Último erro registrado:");
      expect(html).toContain("Connection refused by peer");
    });

    it("exibe estado vazio informativo quando não há fontes cadastradas", () => {
      const html = renderToString(
        <OpportunitySourcesManager initialSources={[]} initialQuota={mockQuota} />,
      );

      expect(html).toContain("Nenhuma fonte de oportunidade configurada");
      expect(html).toContain("Cadastre sua primeira fonte pública ou autorizada");
    });
  });
});

"use client";

import { useState } from "react";
import {
  ArrowSquareOut,
  ArrowsClockwise,
  CheckCircle,
  CircleNotch,
  Gauge,
  Globe,
  Pause,
  Play,
  Plus,
  ShieldCheck,
  Warning,
  WarningOctagon,
  X,
} from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  OpportunitySourceStatus,
  OpportunitySourceView,
  TenantOpportunityQuota,
} from "@/lib/opportunity-intelligence/quotas";
import { TenantQuotaBar } from "./TenantQuotaBar";

const STATUS_CONFIG: Record<
  OpportunitySourceStatus,
  { label: string; variant: "success" | "warning" | "error" | "info" | "neutral" }
> = {
  healthy: { label: "Saudável", variant: "success" },
  running: { label: "Executando", variant: "info" },
  failed: { label: "Falha de Execução", variant: "error" },
  idle: { label: "Ociosa", variant: "neutral" },
  inactive: { label: "Pausada", variant: "warning" },
};

const KIND_LABELS: Record<OpportunitySourceView["source_kind"], string> = {
  open_data: "Dados Abertos Governamentais/Públicos",
  official_api: "API Oficial Autorizada",
  tenant_first_party: "Base Própria do Tenant (First-party)",
};

function formatDate(value: string | null): string {
  if (!value) return "Nunca executada";
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

export function OpportunitySourcesManager({
  initialSources = [],
  initialQuota = null,
}: {
  initialSources?: OpportunitySourceView[];
  initialQuota?: TenantOpportunityQuota | null;
}) {
  const [sources, setSources] = useState<OpportunitySourceView[]>(initialSources);
  const [quota, setQuota] = useState<TenantOpportunityQuota | null>(initialQuota);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // Operations
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    sourceId: string;
    candidates: number;
    safe: boolean;
    outbound: string;
  } | null>(null);
  const [testError, setTestError] = useState<{ sourceId: string; message: string } | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // New source form
  const [showAddModal, setShowAddModal] = useState(false);
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [formName, setFormName] = useState("");
  const [formSourceId, setFormSourceId] = useState("");
  const [formKind, setFormKind] = useState<OpportunitySourceView["source_kind"]>("open_data");
  const [formFeedUrl, setFormFeedUrl] = useState("");
  const [formTermsUrl, setFormTermsUrl] = useState("");
  const [formRegions, setFormRegions] = useState("BR");
  const [formRateLimit, setFormRateLimit] = useState(60);
  const [formMaxRecords, setFormMaxRecords] = useState(100);

  async function refreshData() {
    setLoading(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/v1/opportunity-intelligence/sources");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Falha ao carregar fontes e quotas");
      }
      const json = await res.json();
      if (json?.data) {
        setSources(json.data.sources ?? []);
        setQuota(json.data.quota ?? null);
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Erro desconhecido ao atualizar dados");
    } finally {
      setLoading(false);
    }
  }

  async function handleToggleActive(source: OpportunitySourceView) {
    setTogglingId(source.id);
    setActionError(null);
    try {
      const payload = {
        source_id: source.source_id,
        name: source.name,
        source_kind: source.source_kind,
        feed_url: source.feed_url,
        terms_url: source.terms_url,
        regions: source.regions,
        niche: source.niche,
        offer_key: source.offer_key,
        rate_limit_per_minute: source.rate_limit_per_minute,
        max_records_per_run: source.max_records_per_run,
        is_active: !source.is_active,
      };

      const res = await fetch("/api/v1/opportunity-intelligence/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          err?.error?.message ?? "Não foi possível alterar o estado da fonte no momento.",
        );
      }

      await refreshData();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Falha ao alternar status da fonte.");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleTestSource(source: OpportunitySourceView) {
    setTestingId(source.id);
    setTestResult(null);
    setTestError(null);
    try {
      const res = await fetch(`/api/v1/opportunity-intelligence/sources/${source.id}/test`, {
        method: "POST",
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error?.message ?? "Falha na verificação de conectividade da fonte.");
      }

      setTestResult({
        sourceId: source.id,
        candidates: Number(json?.data?.candidates ?? 0),
        safe: Boolean(json?.data?.safe),
        outbound: String(json?.data?.outbound ?? "blocked"),
      });
    } catch (err) {
      setTestError({
        sourceId: source.id,
        message: err instanceof Error ? err.message : "Erro desconhecido ao testar fonte",
      });
    } finally {
      setTestingId(null);
    }
  }

  async function handleCreateSource(e: React.FormEvent) {
    e.preventDefault();
    setFormSubmitting(true);
    setFormError(null);

    const regions = formRegions
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    if (regions.length === 0) {
      setFormError("Informe ao menos uma região atendida (ex: BR, SP).");
      setFormSubmitting(false);
      return;
    }

    try {
      const payload = {
        name: formName.trim(),
        source_id: formSourceId
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_"),
        source_kind: formKind,
        feed_url: formFeedUrl.trim(),
        terms_url: formTermsUrl.trim(),
        regions,
        rate_limit_per_minute: Number(formRateLimit) || 60,
        max_records_per_run: Number(formMaxRecords) || 100,
        is_active: true,
      };

      const res = await fetch("/api/v1/opportunity-intelligence/sources", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Não foi possível cadastrar a fonte.");
      }

      setShowAddModal(false);
      setFormName("");
      setFormSourceId("");
      setFormFeedUrl("");
      setFormTermsUrl("");
      await refreshData();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Erro ao salvar fonte");
    } finally {
      setFormSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="sources-manager">
      {/* Informative Security Guarantee Banner */}
      <div className="border-info-border flex items-center justify-between gap-3 rounded-lg border bg-info-bg/40 px-4 py-3 text-sm text-info-fg">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="shrink-0 text-accent" aria-hidden />
          <span>
            <strong>Governança de Fontes:</strong> apenas feeds HTTPS públicos ou APIs autorizadas
            são integrados. Segredos e credenciais NUNCA são expostos ou exigidos na UI. O outbound
            permanece 100% blindado.
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refreshData}
          disabled={loading}
          className="shrink-0 text-xs"
          data-testid="refresh-sources-btn"
        >
          {loading ? (
            <CircleNotch size={14} className="animate-spin" aria-hidden />
          ) : (
            <ArrowsClockwise size={14} aria-hidden />
          )}
          Atualizar
        </Button>
      </div>

      {refreshError ? (
        <div className="border-error-border flex items-center justify-between rounded-lg border bg-error-bg/40 p-3 text-xs text-error-fg">
          <span>{refreshError}</span>
          <button type="button" onClick={() => setRefreshError(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="border-error-border flex items-center justify-between rounded-lg border bg-error-bg/40 p-3 text-xs text-error-fg">
          <div className="flex items-center gap-2">
            <WarningOctagon size={16} aria-hidden />
            <span>{actionError}</span>
          </div>
          <button type="button" onClick={() => setActionError(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}

      {/* Real-time Tenant Discovery Quota Bar */}
      {quota ? (
        <TenantQuotaBar
          tokens={quota.opportunities.remaining_this_month}
          capacity={quota.opportunities.monthly_limit}
          refillRatePerMinute={quota.rate_limits.intake_per_minute}
          className="w-full"
        />
      ) : null}

      {/* Quotas KPI Cards */}
      {quota ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-semibold tracking-wider uppercase">Fontes Ativas</span>
              <Gauge size={16} className="text-accent" aria-hidden />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {quota.sources.current_active}{" "}
              <span className="text-sm font-normal text-text-muted">
                / {quota.sources.max_active} máx
              </span>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {quota.sources.can_activate_more ? (
                <span className="text-success-fg">Capacidade disponível para ativação</span>
              ) : (
                <span className="font-medium text-warning-fg">
                  Limite de fontes ativas atingido
                </span>
              )}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-semibold tracking-wider uppercase">Oportunidades (Mês)</span>
              <Globe size={16} className="text-accent" aria-hidden />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {quota.opportunities.created_this_month}{" "}
              <span className="text-sm font-normal text-text-muted">
                / {quota.opportunities.monthly_limit} limite
              </span>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {quota.opportunities.remaining_this_month} restantes ·{" "}
              {quota.opportunities.total_records} acumuladas
            </p>
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-semibold tracking-wider uppercase">Varreduras (24h)</span>
              <ArrowsClockwise size={16} className="text-accent" aria-hidden />
            </div>
            <div className="mt-2 text-2xl font-bold">
              {quota.sweeps.sweeps_today}{" "}
              <span className="text-sm font-normal text-text-muted">execuções</span>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Teto de até {quota.sweeps.max_records_per_run_ceiling} registros por varredura
            </p>
          </div>

          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center justify-between text-xs text-text-muted">
              <span className="font-semibold tracking-wider uppercase">Vazão &amp; Segurança</span>
              <ShieldCheck size={16} className="text-accent" aria-hidden />
            </div>
            <div className="mt-2 text-base font-semibold text-success-fg">
              {quota.governance.copilot_mode ? "Modo Copiloto" : "Autônomo"}
            </div>
            <p className="mt-1 text-xs text-text-muted">
              Coleta: {quota.rate_limits.intake_per_minute}/min · Revisão:{" "}
              {quota.rate_limits.action_review_per_minute}/min
            </p>
          </div>
        </div>
      ) : null}

      {/* Sources Section Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Fontes de Descoberta Cadastradas</h2>
          <p className="text-xs text-text-muted">
            Gerencie os feeds de dados, monitore a última sincronização e execute testes de
            conectividade sem efeitos colaterais.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => setShowAddModal(true)}
          data-testid="add-source-btn"
        >
          <Plus size={14} aria-hidden />
          Cadastrar Nova Fonte
        </Button>
      </div>

      {/* Inline Registration Form Modal */}
      {showAddModal ? (
        <div
          className="rounded-xl border border-border bg-surface p-5 shadow-sm"
          data-testid="add-source-form"
        >
          <div className="flex items-center justify-between border-b border-border pb-3">
            <div className="flex items-center gap-2">
              <Globe size={18} className="text-accent" aria-hidden />
              <h3 className="text-sm font-semibold">Cadastrar Nova Fonte de Descoberta</h3>
            </div>
            <button
              type="button"
              onClick={() => setShowAddModal(false)}
              className="text-text-muted hover:text-text"
              aria-label="Fechar formulário"
            >
              <X size={16} />
            </button>
          </div>

          <form onSubmit={handleCreateSource} className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-text">
                  Nome Amigável da Fonte <span className="text-error">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Diário Oficial de Contratações SP"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text">
                  Identificador Slug <span className="text-error">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: sp_licitacoes_abertas"
                  value={formSourceId}
                  onChange={(e) => setFormSourceId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-text">
                Tipo de Origem <span className="text-error">*</span>
              </label>
              <select
                value={formKind}
                onChange={(e) =>
                  setFormKind(e.target.value as OpportunitySourceView["source_kind"])
                }
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs focus:border-accent focus:outline-none"
              >
                <option value="open_data">{KIND_LABELS.open_data}</option>
                <option value="official_api">{KIND_LABELS.official_api}</option>
                <option value="tenant_first_party">{KIND_LABELS.tenant_first_party}</option>
              </select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-text">
                  URL do Feed JSON (HTTPS público) <span className="text-error">*</span>
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://dados.exemplo.gov.br/feed.json"
                  value={formFeedUrl}
                  onChange={(e) => setFormFeedUrl(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text">
                  URL dos Termos de Uso / Licença <span className="text-error">*</span>
                </label>
                <input
                  type="url"
                  required
                  placeholder="https://dados.exemplo.gov.br/termos-de-uso"
                  value={formTermsUrl}
                  onChange={(e) => setFormTermsUrl(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-xs focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-text">
                  Regiões Atendidas (separadas por vírgula)
                </label>
                <input
                  type="text"
                  placeholder="SP, BR"
                  value={formRegions}
                  onChange={(e) => setFormRegions(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text">Taxa Limite (req/min)</label>
                <input
                  type="number"
                  min={1}
                  max={100000}
                  value={formRateLimit}
                  onChange={(e) => setFormRateLimit(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs focus:border-accent focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-text">
                  Máximo Registros por Varredura
                </label>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={formMaxRecords}
                  onChange={(e) => setFormMaxRecords(Number(e.target.value))}
                  className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-xs focus:border-accent focus:outline-none"
                />
              </div>
            </div>

            <div className="border-info-border rounded-lg border bg-info-bg/30 p-3 text-xs text-info-fg">
              <div className="flex items-center gap-1.5 font-semibold">
                <ShieldCheck size={14} aria-hidden />
                <span>Diretriz Estrita de Segurança</span>
              </div>
              <p className="mt-0.5 text-text-muted">
                Este sistema realiza validação anti-SSRF de DNS e bloqueia IPs internos e redes
                privadas. Não insira credenciais, tokens de API ou dados restritos de clientes.
              </p>
            </div>

            {formError ? (
              <div className="border-error-border rounded-lg border bg-error-bg/40 p-2.5 text-xs text-error-fg">
                {formError}
              </div>
            ) : null}

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowAddModal(false)}
                disabled={formSubmitting}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={formSubmitting}
                data-testid="submit-source-btn"
              >
                {formSubmitting ? (
                  <CircleNotch size={14} className="animate-spin" aria-hidden />
                ) : (
                  <CheckCircle size={14} aria-hidden />
                )}
                Salvar Configuração de Fonte
              </Button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Sources List */}
      <div className="space-y-4">
        {sources.map((source) => {
          const statusMeta = STATUS_CONFIG[source.status];
          const isToggling = togglingId === source.id;
          const isTesting = testingId === source.id;
          const currentTest = testResult?.sourceId === source.id ? testResult : null;
          const currentTestErr = testError?.sourceId === source.id ? testError : null;

          return (
            <div
              key={source.id}
              className="rounded-xl border border-border bg-surface p-5 transition-shadow hover:shadow-xs"
              data-testid="source-card"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold">{source.name}</h3>
                    <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                    <span className="rounded-md border border-border bg-surface-elevated px-2 py-0.5 font-mono text-[11px] text-text-muted">
                      {source.source_id}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {KIND_LABELS[source.source_kind]} · Regiões: {source.regions.join(", ")}
                  </p>
                </div>

                {/* Operations Buttons */}
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    disabled={isTesting || !source.is_active}
                    onClick={() => handleTestSource(source)}
                    data-testid="test-source-btn"
                  >
                    {isTesting ? (
                      <CircleNotch size={13} className="animate-spin" aria-hidden />
                    ) : (
                      <Play size={13} aria-hidden />
                    )}
                    Testar Fonte
                  </Button>

                  <Button
                    type="button"
                    variant={source.is_active ? "outline" : "primary"}
                    size="sm"
                    className="text-xs"
                    disabled={isToggling}
                    onClick={() => handleToggleActive(source)}
                    data-testid="toggle-source-btn"
                  >
                    {isToggling ? (
                      <CircleNotch size={13} className="animate-spin" aria-hidden />
                    ) : source.is_active ? (
                      <>
                        <Pause size={13} aria-hidden />
                        Pausar
                      </>
                    ) : (
                      <>
                        <Play size={13} aria-hidden />
                        Reativar
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Inline Test Result Banner */}
              {currentTest ? (
                <div className="border-success-border mt-3 flex items-center justify-between rounded-lg border bg-success-bg/30 p-2.5 text-xs text-success-fg">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle size={14} aria-hidden />
                    <span>
                      Teste validado com sucesso: {currentTest.candidates} candidatos identificados
                      no feed. Modo seguro ativo, outbound bloqueado.
                    </span>
                  </div>
                  <button type="button" onClick={() => setTestResult(null)}>
                    <X size={13} />
                  </button>
                </div>
              ) : null}

              {currentTestErr ? (
                <div className="border-error-border mt-3 flex items-center justify-between rounded-lg border bg-error-bg/30 p-2.5 text-xs text-error-fg">
                  <div className="flex items-center gap-1.5">
                    <WarningOctagon size={14} aria-hidden />
                    <span>Falha no teste: {currentTestErr.message}</span>
                  </div>
                  <button type="button" onClick={() => setTestError(null)}>
                    <X size={13} />
                  </button>
                </div>
              ) : null}

              {/* Quotas & Sync Details Grid */}
              <div className="bg-surface-subtle/50 mt-4 grid gap-3 rounded-lg border border-border p-3 text-xs sm:grid-cols-3">
                <div>
                  <span className="font-medium text-text-muted">Quotas da Fonte:</span>
                  <p className="mt-0.5 text-text">
                    {source.rate_limit_per_minute} req/min · Até {source.max_records_per_run}{" "}
                    itens/run
                  </p>
                </div>
                <div>
                  <span className="font-medium text-text-muted">Última Execução:</span>
                  <p className="mt-0.5 text-text">{formatDate(source.last_synced_at)}</p>
                  {source.last_execution ? (
                    <p className="text-[11px] text-text-muted">
                      {source.last_execution.candidates_seen} candidatos ·{" "}
                      {source.last_execution.opportunities_created} criadas (
                      {source.last_execution.status})
                    </p>
                  ) : null}
                </div>
                <div>
                  <span className="font-medium text-text-muted">Links Auditáveis:</span>
                  <div className="mt-0.5 flex flex-col gap-1">
                    <a
                      href={source.feed_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      Feed público HTTPS <ArrowSquareOut size={11} aria-hidden />
                    </a>
                    <a
                      href={source.terms_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-text-muted hover:text-text hover:underline"
                    >
                      Termos de licença <ArrowSquareOut size={11} aria-hidden />
                    </a>
                  </div>
                </div>
              </div>

              {/* Last Error Display (Sanitized, no secrets) */}
              {source.last_error ? (
                <div className="border-error-border mt-3 flex items-start gap-2 rounded-lg border bg-error-bg/20 p-2.5 text-xs text-error-fg">
                  <Warning size={15} className="mt-0.5 shrink-0" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <span className="font-semibold">Último erro registrado:</span>
                    <p className="mt-0.5">{source.last_error}</p>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}

        {sources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface p-10 text-center text-sm text-text-muted">
            <Globe size={32} className="mx-auto text-text-muted/60" aria-hidden />
            <p className="mt-2 font-medium">Nenhuma fonte de oportunidade configurada</p>
            <p className="mt-1 text-xs text-text-muted">
              Cadastre sua primeira fonte pública ou autorizada para iniciar a coleta contínua de
              oportunidades.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

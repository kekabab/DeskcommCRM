"use client";

import { useState } from "react";
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  ClipboardText,
  ClockCountdown,
  Gear,
  Lightbulb,
  ShieldCheck,
  Trash,
  Users,
  WarningOctagon,
  X,
} from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OpportunityRadarRow } from "@/lib/opportunity-intelligence/read";
import type {
  OpportunitySourceView,
  TenantOpportunityQuota,
} from "@/lib/opportunity-intelligence/quotas";
import { OpportunityDossierSheet } from "./OpportunityDossierSheet";
import { OpportunitySourcesManager } from "./OpportunitySourcesManager";
import { OpportunityExceptionsQueue } from "./OpportunityExceptionsQueue";

const STATE_META: Record<
  OpportunityRadarRow["state"],
  { label: string; variant: "success" | "warning" | "error" | "info" | "neutral" }
> = {
  awaiting_human: { label: "Revisão humana", variant: "warning" },
  action_ready: { label: "Pronta para rascunho", variant: "success" },
  validating: { label: "Validando", variant: "info" },
  stale: { label: "Evidência vencida", variant: "error" },
  discovered: { label: "Descoberta", variant: "neutral" },
  contacted: { label: "Contato preparado", variant: "info" },
  engaged: { label: "Em conversa", variant: "success" },
  converted: { label: "Convertida", variant: "success" },
  dismissed: { label: "Dispensada", variant: "neutral" },
  suppressed: { label: "Suprimida", variant: "neutral" },
};

const ACTION_LABELS: Record<string, string> = {
  collect_more_evidence: "coletar mais evidência",
  refresh_evidence: "renovar evidência",
  prepare_personalized_draft: "preparar rascunho personalizado",
  request_human_review: "pedir sua revisão",
  link_existing_lead: "vincular ao lead existente",
  suppress: "manter suprimida",
};

function confidenceLabel(value: number): string {
  return `${Math.round(Number(value) * 100)}%`;
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(
    new Date(value),
  );
}

export function OpportunityRadar({
  rows,
  nowIso,
  initialSources = [],
  initialQuota = null,
}: {
  rows: OpportunityRadarRow[];
  nowIso: string;
  initialSources?: OpportunitySourceView[];
  initialQuota?: TenantOpportunityQuota | null;
}) {
  const [activeTab, setActiveTab] = useState<"radar" | "exceptions" | "sources">("radar");
  const [items, setItems] = useState<OpportunityRadarRow[]>(rows);
  const [selectedOppId, setSelectedOppId] = useState<string | null>(null);
  const [dossierOpen, setDossierOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "ready" | "review" | "validating">("all");

  const exceptions = items.filter(
    (row) => row.state === "awaiting_human" || row.state === "stale" || Boolean(row.exception_code),
  );
  const exceptionsCount = exceptions.length;

  const ready = items.filter((row) => row.state === "action_ready").length;
  const review = items.filter((row) => row.state === "awaiting_human").length;
  const validating = items.filter(
    (row) => row.state === "validating" || row.state === "stale",
  ).length;
  const visibleItems = items.filter((row) => {
    if (filter === "ready") return row.state === "action_ready";
    if (filter === "review") return row.state === "awaiting_human";
    if (filter === "validating") return row.state === "validating" || row.state === "stale";
    return true;
  });

  function handleActionReviewed(actionId: string, status: "approved" | "rejected") {
    setItems((prev) =>
      prev.map((item) => {
        if (item.latest_action?.id === actionId) {
          return {
            ...item,
            state: status === "approved" ? "action_ready" : "dismissed",
            latest_action: {
              ...item.latest_action,
              status,
            },
          };
        }
        return item;
      }),
    );
  }

  function openDossier(id: string) {
    setSelectedOppId(id);
    setDossierOpen(true);
  }

  const selectedRow = items.find((row) => row.id === selectedOppId) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      {/* Navigation Tabs */}
      <div className="flex border-b border-border text-sm font-medium">
        <button
          type="button"
          onClick={() => setActiveTab("radar")}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 transition-colors ${
            activeTab === "radar"
              ? "border-accent font-semibold text-accent"
              : "border-transparent text-text-muted hover:text-text"
          }`}
          data-testid="tab-radar"
        >
          <Lightbulb size={16} aria-hidden />
          <span>Radar de Oportunidades</span>
          <Badge variant="neutral" className="ml-1 text-xs">
            {items.length}
          </Badge>
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("exceptions")}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 transition-colors ${
            activeTab === "exceptions"
              ? "border-accent font-semibold text-accent"
              : "border-transparent text-text-muted hover:text-text"
          }`}
          data-testid="tab-exceptions"
        >
          <WarningOctagon
            size={16}
            className={exceptionsCount > 0 ? "text-warning-fg" : ""}
            aria-hidden
          />
          <span>Fila de Exceções</span>
          {exceptionsCount > 0 ? (
            <Badge variant="warning" className="ml-1 text-xs">
              {exceptionsCount}
            </Badge>
          ) : (
            <Badge variant="neutral" className="ml-1 text-xs">
              0
            </Badge>
          )}
        </button>

        <button
          type="button"
          onClick={() => setActiveTab("sources")}
          className={`inline-flex items-center gap-2 border-b-2 px-4 py-3 transition-colors ${
            activeTab === "sources"
              ? "border-accent font-semibold text-accent"
              : "border-transparent text-text-muted hover:text-text"
          }`}
          data-testid="tab-sources"
        >
          <Gear size={16} aria-hidden />
          <span>Gestão de Fontes &amp; Quotas</span>
          <Badge variant="neutral" className="ml-1 text-xs">
            {initialSources.length}
          </Badge>
        </button>
      </div>

      {/* Tab 1: Radar Content */}
      {activeTab === "radar" ? (
        items.length === 0 ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-4"
            data-testid="opportunity-empty"
          >
            <div className="border-info-border flex w-full items-center gap-2 rounded-lg border bg-info-bg/40 px-4 py-3 text-left text-sm text-info-fg">
              <ShieldCheck size={18} aria-hidden />
              <span>
                <strong>Modo Copiloto:</strong> nada é enviado automaticamente.
              </span>
            </div>
            <div className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface p-12 text-center">
              <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-accent">
                <Lightbulb size={24} aria-hidden />
              </div>
              <div>
                <p className="font-medium">Ainda não há oportunidades no radar</p>
                <p className="mt-1 max-w-md text-sm text-text-muted">
                  Nenhuma fonte autorizada trouxe um sinal verificável para esta organização ainda.
                  Quando isso acontecer, ele aparecerá aqui com contexto, evidência e próxima ação.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-5" data-testid="opportunity-radar">
            <div className="grid gap-3 sm:grid-cols-3">
              <SummaryCard
                label="Prontas para agir"
                value={ready}
                tone="success"
                active={filter === "ready"}
                onClick={() => setFilter(filter === "ready" ? "all" : "ready")}
              />
              <SummaryCard
                label="Esperando você"
                value={review}
                tone="warning"
                active={filter === "review"}
                onClick={() => setFilter(filter === "review" ? "all" : "review")}
              />
              <SummaryCard
                label="Ainda validando"
                value={validating}
                tone="info"
                active={filter === "validating"}
                onClick={() => setFilter(filter === "validating" ? "all" : "validating")}
              />
            </div>

            <div className="border-info-border flex items-center gap-2 rounded-lg border bg-info-bg/40 px-4 py-3 text-sm text-info-fg">
              <ShieldCheck size={18} aria-hidden />
              <span>
                <strong>Modo Copiloto:</strong> nada é enviado automaticamente. O sistema só prepara
                a próxima ação e para quando falta lastro.
              </span>
            </div>

            <div className="space-y-3">
              {visibleItems.map((row) => (
                <OpportunityRow
                  key={row.id}
                  row={row}
                  nowIso={nowIso}
                  onOpenDossier={() => openDossier(row.id)}
                  onActionReviewed={handleActionReviewed}
                />
              ))}
              {visibleItems.length === 0 ? (
                <div className="bg-surface-subtle rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
                  Nenhuma oportunidade neste filtro. Selecione outro contador para continuar.
                </div>
              ) : null}
            </div>
          </div>
        )
      ) : null}

      {/* Tab 2: Exception Queue */}
      {activeTab === "exceptions" ? (
        <OpportunityExceptionsQueue
          items={items}
          nowIso={nowIso}
          onOpenDossier={openDossier}
          onActionReviewed={handleActionReviewed}
        />
      ) : null}

      {/* Tab 3: Sources & Quotas Management */}
      {activeTab === "sources" ? (
        <OpportunitySourcesManager initialSources={initialSources} initialQuota={initialQuota} />
      ) : null}

      {/* Shared FACT Dossier Sheet */}
      <OpportunityDossierSheet
        open={dossierOpen}
        onOpenChange={setDossierOpen}
        opportunityId={selectedOppId}
        initialRow={selectedRow}
        onActionReviewed={handleActionReviewed}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone: "success" | "warning" | "info";
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`hover:border-accent-border rounded-xl border bg-surface p-4 text-left transition-colors ${active ? "border-accent ring-1 ring-accent" : "border-border"}`}
    >
      <p className="text-xs font-medium tracking-wide text-text-muted uppercase">{label}</p>
      <p
        className={`mt-2 text-3xl font-semibold ${tone === "success" ? "text-success-fg" : tone === "warning" ? "text-warning-fg" : "text-info-fg"}`}
      >
        {value}
      </p>
      <span className="mt-1 block text-xs text-text-muted">
        {active ? "Filtro ativo · clique para limpar" : "Clique para filtrar"}
      </span>
    </button>
  );
}

function OpportunityRow({
  row,
  nowIso,
  onOpenDossier,
  onActionReviewed,
}: {
  row: OpportunityRadarRow;
  nowIso: string;
  onOpenDossier: () => void;
  onActionReviewed: (actionId: string, status: "approved" | "rejected") => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const state = STATE_META[row.state];
  const signals = row.signals.filter((signal) => signal.key || signal.label).slice(0, 3);
  const actionLabel = row.latest_action
    ? (ACTION_LABELS[row.latest_action.action] ?? row.latest_action.action)
    : "aguardar próxima decisão";

  const isRefreshAction = row.latest_action?.action === "refresh_evidence";
  const approveLabel = isRefreshAction
    ? "Renovar evidência como proposta interna"
    : row.latest_action?.action === "prepare_personalized_draft"
      ? "Aprovar rascunho"
      : row.latest_action?.action === "link_existing_lead"
        ? "Aprovar vínculo de lead"
        : row.latest_action?.action === "collect_more_evidence"
          ? "Aprovar coleta de evidência"
          : "Aprovar proposta interna";

  async function handleDirectReview(status: "approved" | "rejected") {
    if (!row.latest_action) return;
    setSubmitting(true);
    setRowError(null);
    try {
      const res = await fetch(`/api/v1/opportunity-intelligence/actions/${row.latest_action.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          reason: status === "rejected" ? "Descartado com confirmação pelo operador" : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Falha ao registrar decisão da ação.");
      }
      onActionReviewed(row.latest_action.id, status);
      setConfirmDiscard(false);
    } catch (err) {
      setRowError(err instanceof Error ? err.message : "Erro ao processar ação");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <details
      className="group overflow-hidden rounded-xl border border-border bg-surface"
      data-testid="opportunity-row"
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-4 [&::-webkit-details-marker]:hidden">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
          <Lightbulb size={18} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{row.display_name}</h2>
            <Badge variant={state.variant}>{state.label}</Badge>
          </div>
          <p className="mt-1 truncate text-xs text-text-muted">{row.domain ?? row.identity_key}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1">
              <ClockCountdown size={13} aria-hidden /> Confiança {confidenceLabel(row.confidence)}
            </span>
            <span>
              {row.evidence.length} {row.evidence.length === 1 ? "evidência" : "evidências"}
            </span>
            <span>Próximo passo: {actionLabel}</span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-xs"
            onClick={(e) => {
              e.preventDefault();
              onOpenDossier();
            }}
            data-testid="open-dossier-btn"
          >
            <ClipboardText size={14} aria-hidden />
            Dossiê FACT
          </Button>
          <span className="mt-1 text-xs text-text-muted transition-transform group-open:rotate-180">
            ⌄
          </span>
        </div>
      </summary>

      <div className="bg-surface-subtle grid gap-4 border-t border-border px-4 py-4 lg:grid-cols-[1fr_1.2fr]">
        <section>
          <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">
            Sinais observados
          </p>
          {signals.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {signals.map((signal) => (
                <li
                  key={signal.key ?? signal.label}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                >
                  <p className="font-medium">{signal.label ?? signal.key}</p>
                  {signal.evidence_ids?.length ? (
                    <p className="mt-1 text-xs text-text-muted">
                      Lastro:{" "}
                      {signal.evidence_ids
                        .map((evidenceId) => {
                          const evidence = row.evidence.find(
                            (item) => item.evidence_key === evidenceId,
                          );
                          return evidence?.source_id ?? "fonte verificada";
                        })
                        .join(", ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-text-muted">Nenhum sinal estruturado foi registrado.</p>
          )}

          {row.latest_action?.pain_hypothesis ? (
            <div className="border-accent-border mt-3 rounded-lg border bg-accent-soft/40 p-3 text-sm">
              <p className="text-xs font-semibold tracking-wide text-accent uppercase">
                Hipótese de valor
              </p>
              <p className="mt-1">{row.latest_action.pain_hypothesis}</p>
              {row.latest_action.target_offer ? (
                <p className="mt-2 text-xs text-text-muted">
                  Oferta: {row.latest_action.target_offer}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Botões de Ação Direta com Confirmação e Tratamento Seguro */}
          {row.latest_action?.status === "proposed" ? (
            confirmDiscard ? (
              <div
                className="border-error-border mt-3 rounded-lg border bg-error-bg/30 p-2.5 text-xs text-error-fg"
                data-testid="row-discard-confirmation"
              >
                <p className="font-semibold">Confirmar descarte desta oportunidade?</p>
                <p className="mt-0.5 text-text-muted">
                  A oportunidade será movida para o estado dispensada e não entrará no pipeline.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={submitting}
                    onClick={() => handleDirectReview("rejected")}
                    data-testid="row-confirm-reject-btn"
                  >
                    <Trash size={12} aria-hidden />
                    Sim, descartar
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={submitting}
                    onClick={() => setConfirmDiscard(false)}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={submitting}
                  onClick={() => handleDirectReview("approved")}
                  data-testid="row-approve-btn"
                >
                  <Check size={13} aria-hidden />
                  {approveLabel}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={submitting}
                  onClick={() => setConfirmDiscard(true)}
                  data-testid="row-reject-btn"
                >
                  <X size={13} aria-hidden />
                  Descartar
                </Button>
              </div>
            )
          ) : null}

          {rowError ? (
            <div className="border-error-border mt-2 flex items-center justify-between gap-2 rounded-lg border bg-error-bg/40 p-2 text-xs text-error-fg">
              <div className="flex items-center gap-1.5">
                <WarningOctagon size={13} className="shrink-0" aria-hidden />
                <span>{rowError}</span>
              </div>
              <button
                type="button"
                onClick={() => setRowError(null)}
                className="shrink-0 text-text-muted hover:text-text"
                aria-label="Fechar erro"
              >
                <X size={12} aria-hidden />
              </button>
            </div>
          ) : null}
        </section>

        <section>
          <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">
            Evidências rastreáveis
          </p>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
            {row.evidence.length > 0 ? (
              row.evidence.map((evidence) => {
                const expired = evidence.expires_at <= nowIso || row.state === "stale";
                return (
                  <li key={evidence.id} className="p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm leading-5">{evidence.claim}</p>
                      <Badge variant={expired ? "error" : "success"}>
                        {expired ? "Vencida" : "Verificada"}
                      </Badge>
                    </div>
                    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                      <span>{evidence.source_id}</span>
                      <span>
                        coletada {dateLabel(evidence.collected_at)} · válida até{" "}
                        {dateLabel(evidence.expires_at)}
                      </span>
                      <a
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                        href={evidence.source_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Abrir fonte <ArrowSquareOut size={12} aria-hidden />
                      </a>
                    </p>
                  </li>
                );
              })
            ) : (
              <li className="p-3 text-sm text-text-muted">Aguardando evidência verificável.</li>
            )}
          </ul>
        </section>
      </div>

      {row.linked_lead_id ? (
        <div className="bg-surface-subtle/40 flex items-center justify-between border-t border-border px-4 py-2.5 text-xs">
          <div className="flex items-center gap-1.5 text-text-muted">
            <Users size={14} className="shrink-0 text-accent" aria-hidden />
            <span>Lead vinculado no DeskcommCRM</span>
          </div>
          <a
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
            href={`/app/leads/${row.linked_lead_id}`}
            target="_blank"
            rel="noreferrer"
            data-testid="row-linked-lead-link"
          >
            Revisar lead no CRM <ArrowSquareOut size={12} aria-hidden />
          </a>
        </div>
      ) : null}

      {row.state === "awaiting_human" || row.state === "stale" ? (
        <div className="border-warning-border flex items-start gap-2 border-t bg-warning-bg/40 px-4 py-3 text-sm text-warning-fg">
          <WarningOctagon size={17} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <span>
              {row.exception_message ??
                row.latest_action?.reason ??
                "O sistema pausou esta oportunidade até haver uma decisão segura."}
            </span>
            {row.exception_code === "existing_active_lead" && row.linked_lead_id ? (
              <p className="mt-1 text-xs text-text-muted">
                Existe um lead ativo no CRM associado a este contato. Revise os negócios abertos
                antes de tomar uma ação.
              </p>
            ) : null}
          </div>
        </div>
      ) : row.state === "action_ready" ? (
        <div className="border-success-border flex items-start gap-2 border-t bg-success-bg/40 px-4 py-3 text-sm text-success-fg">
          <CheckCircle size={17} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Há evidência suficiente para preparar um rascunho. A aprovação e o envio continuam sob a
            política da organização.
          </span>
        </div>
      ) : null}
    </details>
  );
}

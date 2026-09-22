"use client";

import { useState } from "react";
import {
  ArrowSquareOut,
  Check,
  ClipboardText,
  ClockCountdown,
  ShieldCheck,
  Trash,
  Users,
  WarningOctagon,
  X,
} from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OpportunityRadarRow } from "@/lib/opportunity-intelligence/read";

const EXCEPTION_DESCRIPTIONS: Record<
  string,
  { label: string; description: string; variant: "warning" | "error" | "info" | "neutral" }
> = {
  existing_active_lead: {
    label: "Lead Ativo no CRM",
    description:
      "Um lead ativo já existe no CRM para este contato. É necessária revisão manual para evitar abordagens duplicadas ou desalinhadas.",
    variant: "warning",
  },
  stale_evidence: {
    label: "Evidência Vencida",
    description:
      "O prazo de validade das evidências expirou antes da aprovação da abordagem. É necessária nova validação.",
    variant: "error",
  },
  low_confidence: {
    label: "Baixa Confiança",
    description:
      "A confiança calculada pelo motor está abaixo do limiar de segurança para automação de rascunhos.",
    variant: "info",
  },
  tenant_requires_approval: {
    label: "Aprovação Requerida",
    description:
      "A política configurada para o tenant exige consentimento explícito do operador para esta ação.",
    variant: "warning",
  },
  no_evidence: {
    label: "Sem Evidência Válida",
    description: "Nenhuma evidência verificável foi encontrada para embasar os sinais observados.",
    variant: "error",
  },
  contradictory_evidence: {
    label: "Evidência Contraditória",
    description: "Foram identificados dados conflitantes entre as fontes avaliadas.",
    variant: "error",
  },
  source_policy_unknown: {
    label: "Política da Fonte Não Verificada",
    description: "Os termos de uso da fonte de dados não puderam ser validados automaticamente.",
    variant: "warning",
  },
  missing_value_hypothesis: {
    label: "Hipótese de Valor Ausente",
    description:
      "O motor não conseguiu derivar uma hipótese de dor e proposta de valor comercial consistente.",
    variant: "neutral",
  },
  signal_without_evidence: {
    label: "Sinal sem Lastro",
    description: "O sinal comercial detectado não possui evidência documental associada.",
    variant: "error",
  },
};

function confidenceLabel(value: number): string {
  return `${Math.round(Number(value) * 100)}%`;
}

export function OpportunityExceptionsQueue({
  items,
  nowIso,
  onOpenDossier,
  onActionReviewed,
}: {
  items: OpportunityRadarRow[];
  nowIso: string;
  onOpenDossier: (id: string) => void;
  onActionReviewed: (actionId: string, status: "approved" | "rejected") => void;
}) {
  const [filterCode, setFilterCode] = useState<string>("all");

  const exceptions = items.filter(
    (row) => row.state === "awaiting_human" || row.state === "stale" || Boolean(row.exception_code),
  );

  const leadsInCrm = exceptions.filter((r) => r.exception_code === "existing_active_lead").length;
  const staleEvidence = exceptions.filter(
    (r) => r.exception_code === "stale_evidence" || r.state === "stale",
  ).length;
  const lowConfidence = exceptions.filter((r) => r.exception_code === "low_confidence").length;

  const filteredExceptions = exceptions.filter((row) => {
    if (filterCode === "all") return true;
    if (filterCode === "existing_active_lead") return row.exception_code === "existing_active_lead";
    if (filterCode === "stale")
      return row.exception_code === "stale_evidence" || row.state === "stale";
    if (filterCode === "low_confidence") return row.exception_code === "low_confidence";
    if (filterCode === "other")
      return (
        row.exception_code !== "existing_active_lead" &&
        row.exception_code !== "stale_evidence" &&
        row.exception_code !== "low_confidence" &&
        row.state !== "stale"
      );
    return true;
  });

  return (
    <div className="flex flex-col gap-5" data-testid="exceptions-queue">
      {/* Informative Banner */}
      <div className="border-warning-border flex items-start gap-3 rounded-lg border bg-warning-bg/30 p-4 text-sm text-warning-fg">
        <WarningOctagon size={20} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">Fila de Exceções e Resolução Segura</p>
          <p className="mt-1 text-xs text-text-muted">
            O motor de inteligência pausa preventivamente a progressão autônoma quando detecta
            colisão com leads existentes no CRM, expiração de evidências ou confiança insuficiente.
            Inspecione o Dossiê FACT ou execute a resolução informada.
          </p>
        </div>
      </div>

      {/* Exception Categories Filter Chips */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={() => setFilterCode("all")}
          className={`rounded-lg border px-3 py-1.5 font-medium transition-colors ${
            filterCode === "all"
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface text-text-muted hover:text-text"
          }`}
        >
          Todas as Exceções ({exceptions.length})
        </button>
        <button
          type="button"
          onClick={() => setFilterCode("existing_active_lead")}
          className={`rounded-lg border px-3 py-1.5 font-medium transition-colors ${
            filterCode === "existing_active_lead"
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface text-text-muted hover:text-text"
          }`}
        >
          Leads Ativos no CRM ({leadsInCrm})
        </button>
        <button
          type="button"
          onClick={() => setFilterCode("stale")}
          className={`rounded-lg border px-3 py-1.5 font-medium transition-colors ${
            filterCode === "stale"
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface text-text-muted hover:text-text"
          }`}
        >
          Evidência Vencida ({staleEvidence})
        </button>
        <button
          type="button"
          onClick={() => setFilterCode("low_confidence")}
          className={`rounded-lg border px-3 py-1.5 font-medium transition-colors ${
            filterCode === "low_confidence"
              ? "border-accent bg-accent-soft text-accent"
              : "border-border bg-surface text-text-muted hover:text-text"
          }`}
        >
          Baixa Confiança ({lowConfidence})
        </button>
      </div>

      {/* Exception Rows */}
      <div className="space-y-3">
        {filteredExceptions.map((row) => (
          <ExceptionRowItem
            key={row.id}
            row={row}
            nowIso={nowIso}
            onOpenDossier={() => onOpenDossier(row.id)}
            onActionReviewed={onActionReviewed}
          />
        ))}

        {filteredExceptions.length === 0 ? (
          <div
            className="rounded-xl border border-dashed border-border bg-surface p-12 text-center text-sm text-text-muted"
            data-testid="exceptions-empty"
          >
            <ShieldCheck size={32} className="mx-auto text-success-fg" aria-hidden />
            <p className="mt-2 font-medium">Nenhuma exceção retida nesta categoria</p>
            <p className="mt-1 text-xs text-text-muted">
              Todas as oportunidades analisadas estão no fluxo normal do Radar ou já foram
              resolvidas.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ExceptionRowItem({
  row,
  nowIso: _nowIso,
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
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const exceptionKey =
    row.exception_code ?? (row.state === "stale" ? "stale_evidence" : "tenant_requires_approval");
  const exceptionMeta = EXCEPTION_DESCRIPTIONS[exceptionKey] ?? {
    label: "Revisão Requerida",
    description: row.exception_message ?? "Decisão do operador necessária para continuar.",
    variant: "warning",
  };

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

  async function handleReview(status: "approved" | "rejected") {
    if (!row.latest_action) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/opportunity-intelligence/actions/${row.latest_action.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          reason:
            status === "rejected" ? "Descartado pelo operador na fila de exceções" : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Falha ao processar resolução da exceção.");
      }

      onActionReviewed(row.latest_action.id, status);
      setConfirmDiscard(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Erro ao resolver exceção");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="hover:border-accent-border rounded-xl border border-border bg-surface p-4 transition-all"
      data-testid="exception-row"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{row.display_name}</h3>
            <Badge variant={exceptionMeta.variant}>{exceptionMeta.label}</Badge>
            <span className="inline-flex items-center gap-1 font-mono text-xs text-text-muted">
              <ClockCountdown size={13} aria-hidden /> Confiança: {confidenceLabel(row.confidence)}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-text-muted">
            {row.domain ?? row.identity_key}
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenDossier}
          className="text-xs"
          data-testid="open-dossier-btn"
        >
          <ClipboardText size={14} aria-hidden />
          Inspecionar Dossiê FACT
        </Button>
      </div>

      {/* Specific Exception Rationale */}
      <div className="bg-surface-subtle/70 mt-3 rounded-lg border border-border p-3 text-xs">
        <div className="flex items-start gap-2">
          <WarningOctagon size={15} className="mt-0.5 shrink-0 text-warning-fg" aria-hidden />
          <div>
            <span className="font-semibold text-text">Diagnóstico do Supervisor:</span>
            <p className="mt-0.5 text-text-muted">
              {row.exception_message ?? exceptionMeta.description}
            </p>
          </div>
        </div>
      </div>

      {/* Linked Lead CRM Context Bar */}
      {row.linked_lead_id ? (
        <div className="mt-2 flex items-center justify-between rounded-lg border border-border bg-accent-soft/30 px-3 py-2 text-xs">
          <div className="flex items-center gap-1.5 text-text-muted">
            <Users size={14} className="shrink-0 text-accent" aria-hidden />
            <span>Lead existente vinculado no CRM</span>
          </div>
          <a
            href={`/app/leads/${row.linked_lead_id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
            data-testid="exception-linked-lead-link"
          >
            Revisar lead no CRM <ArrowSquareOut size={12} aria-hidden />
          </a>
        </div>
      ) : null}

      {/* Sinais Observados e Frescor */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-text-muted">
        <div>
          <span>
            {row.signals.length}{" "}
            {row.signals.length === 1 ? "sinal detectado" : "sinais detectados"} ·{" "}
            {row.evidence.length} {row.evidence.length === 1 ? "evidência" : "evidências"}
          </span>
        </div>

        {/* Quick Resolution Controls */}
        {row.latest_action?.status === "proposed" ? (
          confirmDiscard ? (
            <div className="flex items-center gap-2" data-testid="exception-discard-confirmation">
              <span className="text-xs font-medium text-error-fg">Confirmar descarte?</span>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="text-xs"
                disabled={submitting}
                onClick={() => handleReview("rejected")}
                data-testid="exception-confirm-reject-btn"
              >
                <Trash size={12} aria-hidden />
                Sim, descartar
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={submitting}
                onClick={() => setConfirmDiscard(false)}
              >
                Cancelar
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="text-xs"
                disabled={submitting}
                onClick={() => handleReview("approved")}
                data-testid="exception-approve-btn"
              >
                <Check size={13} aria-hidden />
                {approveLabel}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs"
                disabled={submitting}
                onClick={() => setConfirmDiscard(true)}
                data-testid="exception-reject-btn"
              >
                <X size={13} aria-hidden />
                Descartar
              </Button>
            </div>
          )
        ) : null}
      </div>

      {errorMsg ? (
        <div className="border-error-border mt-2 flex items-center justify-between rounded-lg border bg-error-bg/40 p-2 text-xs text-error-fg">
          <span>{errorMsg}</span>
          <button type="button" onClick={() => setErrorMsg(null)}>
            <X size={12} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

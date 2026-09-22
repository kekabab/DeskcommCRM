"use client";

import { useEffect, useState } from "react";
import {
  ArrowSquareOut,
  Check,
  CheckCircle,
  ClipboardText,
  ShieldCheck,
  Trash,
  Users,
  WarningOctagon,
  X,
} from "@/lib/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { OpportunityDossier, OpportunityRadarRow } from "@/lib/opportunity-intelligence/read";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opportunityId: string | null;
  initialRow?: OpportunityRadarRow | null;
  onActionReviewed?: (actionId: string, status: "approved" | "rejected") => void;
}

export function OpportunityDossierSheet({
  open,
  onOpenChange,
  opportunityId,
  initialRow,
  onActionReviewed,
}: Props) {
  const [dossier, setDossier] = useState<OpportunityDossier | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !opportunityId) return;

    let isMounted = true;

    fetch(`/api/v1/opportunity-intelligence/dossier/${opportunityId}`)
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err?.error?.message ?? "Falha ao carregar dossiê");
        }
        return res.json();
      })
      .then((payload) => {
        if (isMounted) {
          setDossier(payload.data);
        }
      })
      .catch((err) => {
        if (isMounted) {
          setErrorMessage(err instanceof Error ? err.message : "Erro desconhecido");
        }
      })
      .finally(() => {
        isMounted = false;
      });

    return () => {
      isMounted = false;
    };
  }, [open, opportunityId]);

  const displayName = dossier?.record.display_name ?? initialRow?.display_name ?? "Oportunidade";
  const domain = dossier?.record.domain ?? initialRow?.domain;
  const state = dossier?.record.state ?? initialRow?.state ?? "discovered";
  const confidence = dossier?.record.confidence ?? initialRow?.confidence ?? 0;
  const activeAction = dossier?.active_action ?? initialRow?.latest_action ?? null;
  const linkedLeadId = dossier?.record.linked_lead_id ?? initialRow?.linked_lead_id ?? null;
  const loading = Boolean(open && opportunityId && !dossier && !errorMessage);

  const isRefreshAction = activeAction?.action === "refresh_evidence";
  const approveButtonLabel = isRefreshAction
    ? "Renovar evidência como proposta interna"
    : activeAction?.action === "prepare_personalized_draft"
      ? "Aprovar rascunho"
      : activeAction?.action === "link_existing_lead"
        ? "Aprovar vínculo de lead"
        : activeAction?.action === "collect_more_evidence"
          ? "Aprovar coleta de evidência"
          : "Aprovar proposta interna";

  async function handleReviewAction(status: "approved" | "rejected") {
    if (!activeAction) return;
    setActionLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/v1/opportunity-intelligence/actions/${activeAction.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          status,
          reason: status === "rejected" ? "Descartado com confirmação pelo operador" : undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? "Falha ao registrar decisão");
      }

      const updated = await res.json();
      if (dossier) {
        setDossier({
          ...dossier,
          record: {
            ...dossier.record,
            state: updated.data.opportunity_state,
          },
          active_action: {
            ...activeAction,
            status: updated.data?.status ?? status,
          },
        });
      }
      onActionReviewed?.(activeAction.id, status);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Erro ao revisar ação");
    } finally {
      setActionLoading(false);
    }
  }

  function handleSheetOpenChange(nextOpen: boolean) {
    if (!nextOpen) {
      setDossier(null);
      setErrorMessage(null);
      setConfirmDiscard(false);
    }
    onOpenChange(nextOpen);
  }

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-6 sm:max-w-2xl"
        data-testid="opportunity-dossier-sheet"
      >
        <SheetHeader className="border-b border-border pb-4">
          <div className="flex items-center gap-2 text-xs font-medium tracking-wider text-accent uppercase">
            <ClipboardText size={15} aria-hidden />
            Dossiê FACT
          </div>
          <SheetTitle className="mt-1 truncate text-xl font-bold">{displayName}</SheetTitle>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-muted">
            {domain ? <span className="font-mono">{domain}</span> : null}
            <span>·</span>
            <span>Confiança: {Math.round(confidence * 100)}%</span>
            <span>·</span>
            <Badge variant="outline">{state}</Badge>
          </div>
        </SheetHeader>

        <div className="border-info-border mt-4 flex items-center gap-2 rounded-lg border bg-info-bg/40 px-3 py-2 text-xs text-info-fg">
          <ShieldCheck size={16} className="shrink-0" aria-hidden />
          <span>
            <strong>Modo Copiloto:</strong> toda abordagem precisa de aprovação humana explícita
            antes do envio.
          </span>
        </div>

        {errorMessage ? (
          <div className="border-error-border mt-4 flex items-center justify-between gap-2 rounded-lg border bg-error-bg/40 p-3 text-xs text-error-fg">
            <div className="flex items-center gap-2">
              <WarningOctagon size={16} className="shrink-0" aria-hidden />
              <span>{errorMessage}</span>
            </div>
            <button
              type="button"
              onClick={() => setErrorMessage(null)}
              className="shrink-0 text-text-muted hover:text-text"
              aria-label="Fechar mensagem de erro"
            >
              <X size={14} aria-hidden />
            </button>
          </div>
        ) : null}

        {loading && !dossier ? (
          <div className="flex flex-1 items-center justify-center p-12 text-sm text-text-muted">
            Carregando evidências e histórico...
          </div>
        ) : null}

        {dossier ? (
          <div className="mt-6 flex flex-col gap-6">
            {/* Vínculo e Revisão de Lead no CRM */}
            {linkedLeadId ? (
              <div
                className="flex items-center justify-between rounded-xl border border-border bg-surface p-3.5 text-xs"
                data-testid="dossier-linked-lead-box"
              >
                <div className="flex items-center gap-2.5">
                  <Users size={16} className="shrink-0 text-accent" aria-hidden />
                  <div>
                    <p className="font-semibold text-text">Lead existente no DeskcommCRM</p>
                    <p className="mt-0.5 text-text-muted">
                      Empresa já cadastrada na base de contatos
                    </p>
                  </div>
                </div>
                <a
                  href={`/app/leads/${linkedLeadId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="bg-surface-subtle inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 font-medium text-accent hover:bg-surface hover:underline"
                  data-testid="dossier-linked-lead-link"
                >
                  Revisar lead no CRM <ArrowSquareOut size={12} aria-hidden />
                </a>
              </div>
            ) : null}

            {/* Decisão do Operador sobre a Ação */}
            {activeAction ? (
              <section
                className="border-accent-border rounded-xl border bg-accent-soft/30 p-4"
                data-testid="dossier-action-box"
              >
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold tracking-wide text-accent uppercase">
                    Próxima Ação Sugerida
                  </p>
                  <Badge
                    variant={
                      activeAction.status === "approved"
                        ? "success"
                        : activeAction.status === "rejected"
                          ? "error"
                          : "warning"
                    }
                  >
                    {activeAction.status === "proposed"
                      ? "Pendente de aprovação"
                      : activeAction.status}
                  </Badge>
                </div>
                <p className="mt-2 text-sm font-medium">{activeAction.action}</p>
                {activeAction.reason ? (
                  <p className="mt-1 text-xs text-text-muted">{activeAction.reason}</p>
                ) : null}

                {activeAction.status === "proposed" ? (
                  confirmDiscard ? (
                    <div
                      className="border-error-border mt-4 rounded-lg border bg-error-bg/30 p-3 text-xs text-error-fg"
                      data-testid="dossier-discard-confirmation"
                    >
                      <p className="font-semibold">Confirmar descarte desta oportunidade?</p>
                      <p className="mt-1 text-text-muted">
                        A oportunidade será movida para o estado dispensada e não entrará na fila de
                        abordagem.
                      </p>
                      <div className="mt-3 flex items-center gap-2">
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={actionLoading}
                          onClick={() => {
                            setConfirmDiscard(false);
                            handleReviewAction("rejected");
                          }}
                          data-testid="confirm-reject-btn"
                        >
                          <Trash size={13} aria-hidden />
                          Sim, descartar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={actionLoading}
                          onClick={() => setConfirmDiscard(false)}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 flex flex-wrap items-center gap-3">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={actionLoading}
                        onClick={() => handleReviewAction("approved")}
                        data-testid="approve-action-btn"
                      >
                        <Check size={14} aria-hidden />
                        {approveButtonLabel}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={actionLoading}
                        onClick={() => setConfirmDiscard(true)}
                        data-testid="reject-action-btn"
                      >
                        <X size={14} aria-hidden />
                        Descartar ação
                      </Button>
                    </div>
                  )
                ) : activeAction.status === "approved" ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-success-fg">
                    <CheckCircle size={15} aria-hidden />
                    <span>
                      Aprovada pelo operador. Pronta para preparação de rascunho interno no CRM.
                    </span>
                  </div>
                ) : activeAction.status === "executed" ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-success-fg">
                    <CheckCircle size={15} aria-hidden />
                    <span>
                      Vínculo executado com sucesso e registrado na timeline de atividades do lead.
                    </span>
                  </div>
                ) : activeAction.status === "rejected" ? (
                  <div className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                    <X size={15} aria-hidden />
                    <span>Ação dispensada pelo operador.</span>
                  </div>
                ) : null}
              </section>
            ) : null}

            {/* F — Fatos Observados */}
            <section>
              <h3 className="text-xs font-semibold tracking-wider text-text-muted uppercase">
                F — Fatos Observados (Sinais)
              </h3>
              <ul className="mt-2 space-y-2">
                {dossier.fact.facts.map((fact, idx) => (
                  <li key={idx} className="rounded-lg border border-border bg-surface p-3 text-sm">
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-text">{fact.claim}</p>
                      <Badge variant="neutral">{Math.round(fact.confidence * 100)}%</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* A — Âncoras & Frescor */}
            <section>
              <h3 className="text-xs font-semibold tracking-wider text-text-muted uppercase">
                A — Âncoras & Frescor de Fonte
              </h3>
              <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
                {dossier.fact.anchors.map((anchor, idx) => (
                  <li key={idx} className="flex flex-col gap-1.5 p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-text">{anchor.source_id}</span>
                      <Badge variant={anchor.is_expired ? "error" : "success"}>
                        {anchor.is_expired ? "Vencida" : "Fresca / Válida"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-text-muted">
                      <span>
                        Coleta:{" "}
                        {new Intl.DateTimeFormat("pt-BR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(anchor.collected_at))}
                      </span>
                      <a
                        href={anchor.source_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-accent hover:underline"
                      >
                        Fonte <ArrowSquareOut size={11} aria-hidden />
                      </a>
                      <a
                        href={anchor.terms_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-text-muted hover:underline"
                      >
                        Termos <ArrowSquareOut size={11} aria-hidden />
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* C — Consequência Comercial */}
            <section>
              <h3 className="text-xs font-semibold tracking-wider text-text-muted uppercase">
                C — Consequência Comercial
              </h3>
              <div className="mt-2 rounded-lg border border-border bg-surface p-3 text-sm">
                <p className="text-xs font-medium text-text-muted uppercase">
                  Dor / Custo da Inação
                </p>
                <p className="mt-1 text-text">
                  {dossier.fact.consequence.pain_hypothesis ?? "Nenhuma hipótese de dor formulada."}
                </p>
                {dossier.fact.consequence.inaction_risk ? (
                  <div className="border-warning-border mt-2 rounded border bg-warning-bg/30 p-2 text-xs text-warning-fg">
                    {dossier.fact.consequence.inaction_risk}
                  </div>
                ) : null}
              </div>
            </section>

            {/* T — Prova Tangível */}
            <section>
              <h3 className="text-xs font-semibold tracking-wider text-text-muted uppercase">
                T — Prova Tangível
              </h3>
              <div className="mt-2 space-y-2">
                <div className="rounded-lg border border-border bg-surface p-3 text-sm">
                  <p className="text-xs font-medium text-text-muted uppercase">
                    Oferta Direcionada
                  </p>
                  <p className="mt-1 text-text">
                    {dossier.fact.tangible_proof.target_offer ??
                      "Aguardando definição da estratégia."}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3 text-sm">
                  <p className="text-xs font-medium text-text-muted uppercase">
                    Mini Prova de Valor / Ativo
                  </p>
                  <p className="mt-1 text-text">
                    {dossier.fact.tangible_proof.proof_asset_summary ?? "Nenhum ativo gerado."}
                  </p>
                </div>
              </div>
            </section>

            {/* Histórico de Resultados */}
            {dossier.outcomes.length > 0 ? (
              <section>
                <h3 className="text-xs font-semibold tracking-wider text-text-muted uppercase">
                  Histórico de Respostas (Outcomes)
                </h3>
                <ul className="mt-2 divide-y divide-border rounded-lg border border-border bg-surface">
                  {dossier.outcomes.map((out) => (
                    <li key={out.id} className="flex items-center justify-between p-3 text-xs">
                      <div>
                        <span className="font-semibold text-text uppercase">{out.kind}</span>
                        {out.reason ? <p className="mt-0.5 text-text-muted">{out.reason}</p> : null}
                      </div>
                      <span className="text-text-muted">
                        {new Intl.DateTimeFormat("pt-BR", {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(out.occurred_at))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

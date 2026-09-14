"use client";

import { useState, useRef, useEffect } from "react";
import { useT } from "@/hooks/i18n/useT";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Robot, PaperPlaneTilt } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface MensagemSimulada {
  id: string;
  remetente: "cliente" | "atendente" | "sistema";
  texto: string;
  data: string;
}

export function SimuladorModal({ open, onOpenChange }: Props) {
  const t = useT();
  const [mensagem, setMensagem] = useState("");
  const [carregando, setCarregando] = useState(false);
  const [erroRota, setErroRota] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [mensagens, setMensagens] = useState<MensagemSimulada[]>(() => [
    {
      id: "boas-vindas",
      remetente: "sistema",
      texto: t(
        "Modo de simulação ativo. As mensagens trocadas aqui não saem para o WhatsApp e não disparam cobranças de provedores.",
      ),
      data: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
    {
      id: "saudacao-agente",
      remetente: "atendente",
      texto: t(
        "Olá! Sou seu atendente virtual. Como posso ajudar com os serviços ou agendamentos hoje?",
      ),
      data: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    },
  ]);

  const fimMensagensRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      fimMensagensRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [open, mensagens]);

  async function enviarSimulacao(e?: React.FormEvent) {
    if (e) e.preventDefault();
    const textoLimpo = mensagem.trim();
    if (!textoLimpo || carregando) return;

    const novaMensagem: MensagemSimulada = {
      id: `cli-${Date.now()}`,
      remetente: "cliente",
      texto: textoLimpo,
      data: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMensagens((antigas) => [...antigas, novaMensagem]);
    setMensagem("");
    setCarregando(true);
    setErroRota(null);

    try {
      // Consumo estrito da rota planejada POST /api/v1/simulator/messages
      const res = await fetch("/api/v1/simulator/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: textoLimpo,
          ...(conversationId ? { conversation_id: conversationId } : {}),
        }),
      });

      if (!res.ok) {
        // Se a rota planejada responder 404, 501 ou erro, apresenta estado gracioso sem crash
        if (res.status === 404 || res.status === 501) {
          setErroRota(
            t(
              "A rota planejada POST /api/v1/simulator/messages aguarda ativação pelo motor de runtime (Duna). O envio local foi retido com segurança sem egressos.",
            ),
          );
        } else {
          const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          setErroRota(
            json.error?.message ?? `${t("O simulador respondeu com erro")} (HTTP ${res.status}).`,
          );
        }
        return;
      }

      const data = (await res.json()) as {
        data?: {
          response_text?: string;
          reply?: string;
          final_text?: string;
          outbound_message?: { body?: string };
        };
      };
      const respostaTexto =
        data.data?.outbound_message?.body ??
        data.data?.response_text ??
        data.data?.reply ??
        data.data?.final_text ??
        t("Recebido pela simulação.");

      const returnedConversationId = (data.data as { conversation_id?: unknown } | undefined)
        ?.conversation_id;
      if (typeof returnedConversationId === "string") {
        setConversationId(returnedConversationId);
      }

      setMensagens((antigas) => [
        ...antigas,
        {
          id: `atd-${Date.now()}`,
          remetente: "atendente",
          texto: respostaTexto,
          data: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err) {
      setErroRota(
        `${t("Não foi possível conectar ao simulador local:")} ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setCarregando(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(650px,90vh)] max-w-lg flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b bg-card p-4">
          <div className="flex items-center justify-between gap-2 pr-6">
            <div className="flex items-center gap-2">
              <Robot size={20} className="text-primary" weight="duotone" aria-hidden />
              <DialogTitle className="text-base font-semibold">
                {t("Simulador de Atendimento")}
              </DialogTitle>
            </div>
            <Badge
              variant="outline"
              className="border-primary/40 bg-primary/5 text-[11px] font-normal text-primary"
            >
              {t("Modo Local — Sem Egressos")}
            </Badge>
          </div>
          <DialogDescription className="mt-1 text-xs text-muted-foreground">
            {t(
              "Teste como o atendente virtual do seu negócio responde a clientes e conduz agendamentos, sem usar WhatsApp real.",
            )}
          </DialogDescription>
        </DialogHeader>

        {/* Thread de mensagens com região acessível para leitores de tela */}
        <div
          className="flex-1 space-y-3 overflow-y-auto bg-muted/20 p-4"
          aria-live="polite"
          aria-atomic="false"
          role="log"
        >
          {mensagens.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex max-w-[85%] flex-col rounded-lg p-3 text-sm",
                msg.remetente === "cliente" &&
                  "ml-auto rounded-br-none bg-primary text-primary-foreground",
                msg.remetente === "atendente" &&
                  "mr-auto rounded-bl-none border bg-card text-card-foreground shadow-xs",
                msg.remetente === "sistema" &&
                  "mx-auto max-w-[95%] rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-center text-xs text-amber-900 dark:text-amber-200",
              )}
            >
              {msg.remetente !== "sistema" && (
                <span className="mb-1 text-[10px] font-medium opacity-70">
                  {msg.remetente === "cliente" ? t("Você (como cliente)") : t("Atendente Virtual")}
                </span>
              )}
              <p className="whitespace-pre-wrap">{msg.texto}</p>
              <span className="mt-1 self-end text-[9px] opacity-60">{msg.data}</span>
            </div>
          ))}

          {carregando && (
            <div className="mr-auto max-w-[85%] animate-pulse rounded-lg rounded-bl-none border bg-card p-3 text-sm text-muted-foreground shadow-xs">
              <span className="mb-1 block text-[10px] font-medium opacity-70">
                {t("Atendente Virtual")}
              </span>
              {t("Digitando resposta...")}
            </div>
          )}

          {erroRota && (
            <div
              role="alert"
              className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200"
            >
              <p className="font-semibold">{t("Aviso do Simulador Local:")}</p>
              <p>{erroRota}</p>
            </div>
          )}

          <div ref={fimMensagensRef} />
        </div>

        {/* Formulário de envio */}
        <form onSubmit={enviarSimulacao} className="space-y-2 border-t bg-card p-3">
          <div className="space-y-1">
            <Label htmlFor="simulador-input" className="sr-only">
              {t("Mensagem para o simulador")}
            </Label>
            <div className="flex gap-2">
              <Textarea
                id="simulador-input"
                value={mensagem}
                onChange={(e) => setMensagem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void enviarSimulacao();
                  }
                }}
                placeholder={t("Escreva como cliente (ex.: Quero agendar para amanhã...)")}
                rows={1}
                className="max-h-[100px] min-h-[40px] resize-none text-sm"
                disabled={carregando}
              />
              <Button
                type="submit"
                size="icon"
                disabled={carregando || !mensagem.trim()}
                className="h-10 w-10 shrink-0"
                aria-label={t("Enviar mensagem simulada")}
              >
                <PaperPlaneTilt size={16} aria-hidden />
              </Button>
            </div>
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            {t("Pressione Enter para enviar. Shift + Enter para quebra de linha.")}
          </p>
        </form>
      </DialogContent>
    </Dialog>
  );
}

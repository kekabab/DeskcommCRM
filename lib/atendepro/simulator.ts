/**
 * Runtime mínimo da conversa persistente do simulador local AtendePro.
 *
 * Contrato e diretrizes consumindo a migration 20260913160000_0239_canal_simulador_local.sql:
 *  - docs/atendepro/contract-cross-review.md (§1.2, §1.3, §1.4)
 *  - Sessão do canal: provider = 'simulator', simulator_session_key = 'atendepro-local-<orgId>', sem referencia de transporte externo.
 *  - Conversa: channel = 'simulator', sem fallback para whatsapp.
 *  - Falha fechada com MigrationPendingError (código 'migration_pending') se a migration não estiver aplicada.
 *  - Contrato de entrada da UI: campo canônico 'body' (com suporte a fallback de 'message'), conversation_id UUID opcional.
 *  - Zero-egress garantido: sem chamadas de rede externas e sem LLM pago.
 *  - Persistência real: reutiliza contacts, conversations e messages sem duplicar entidades.
 *  - Schema real de messages: apenas colunas reais (direction, status, type, sent_via, body, metadata; sem sender_type).
 *  - Filtros explícitos de organization_id em todas as consultas e mutações.
 *  - Portas abertas para crm_create_lead e crm_move_lead_stage auditáveis.
 *  - is_dry_run = false para simulação persistente (preview dry-run continua segregado).
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError } from "@/lib/api/types";
import { createAdminClient } from "@/lib/supabase/admin";
import { audit } from "@/lib/audit";
import { createLeadHandler, moveLeadHandler } from "@/app/api/v1/leads/_handler";
import type { CreateLeadInput } from "@/lib/schemas/leads";

// -----------------------------------------------------------------------------
// Erro customizado de migration pendente
// -----------------------------------------------------------------------------

export class MigrationPendingError extends Error {
  readonly code = "migration_pending";
  constructor(
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "MigrationPendingError";
  }
}

// -----------------------------------------------------------------------------
// Schemas e Tipos
// -----------------------------------------------------------------------------

const rawSimulatorInputSchema = z
  .object({
    conversation_id: z.string().uuid().optional(),
    contact: z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(120).optional(),
        phone_number: z.string().min(8).max(30).optional(),
      })
      .optional(),
    /** Campo canônico da mensagem enviada pelo usuário */
    body: z.string().min(1).max(4096).optional(),
    /** Suporte defensivo caso algum client envie 'message' */
    message: z.string().min(1).max(4096).optional(),
    scenario: z.enum(["auto", "qualificacao", "agendamento", "duvida"]).optional().default("auto"),
    lead_action: z
      .object({
        action: z.enum(["create", "move_stage"]),
        pipeline_id: z.string().uuid().optional(),
        stage_id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        lead_id: z.string().uuid().optional(),
        reason: z.string().max(500).optional(),
      })
      .optional(),
  })
  .strict();

export const simulatorMessageInputSchema = rawSimulatorInputSchema.transform((data) => {
  const content = data.body ?? data.message;
  if (!content || content.trim().length === 0) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["body"],
        message: "O campo 'body' é obrigatório.",
      },
    ]);
  }
  return {
    ...data,
    body: content.trim(),
  };
});

export type SimulatorMessageInput = z.infer<typeof simulatorMessageInputSchema>;

export interface SimulatorTurnOptions {
  organizationId: string;
  actorUserId: string;
  requestId: string;
  supabase?: SupabaseClient;
}

export interface SimulatorTurnResult {
  conversation_id: string;
  contact_id: string;
  channel_session_id: string;
  inbound_message: {
    id: string;
    body: string;
    direction: "inbound";
    status: "received";
    sent_via: "user";
    sent_at: string;
  };
  outbound_message: {
    id: string;
    body: string;
    direction: "outbound";
    status: "delivered";
    sent_via: "ai";
    sent_at: string;
  };
  declaration: {
    nada_a_declarar: boolean;
    intencao_detectada: string;
    resumo: string;
  };
  lead_mutation?: {
    action: "created" | "moved";
    lead: Record<string, unknown>;
  };
}

// -----------------------------------------------------------------------------
// Respostas Determinísticas (Mock de LLM sem rede)
// -----------------------------------------------------------------------------

function gerarRespostaDeterministica(
  body: string,
  scenario: string,
  contactName: string,
): { replyText: string; intencao: string; resumo: string } {
  const lower = body.toLowerCase();

  if (
    scenario === "agendamento" ||
    lower.includes("agend") ||
    lower.includes("horário") ||
    lower.includes("horario") ||
    lower.includes("marcar")
  ) {
    return {
      replyText: `Olá, ${contactName}! Temos horários disponíveis para atendimento amanhã às 14:00 e às 16:30. Qual desses horários fica melhor para você?`,
      intencao: "agendamento_servico",
      resumo: "Cliente solicitou consulta de horários disponíveis para agendamento.",
    };
  }

  if (
    scenario === "qualificacao" ||
    lower.includes("orçamento") ||
    lower.includes("orcamento") ||
    lower.includes("preço") ||
    lower.includes("preco") ||
    lower.includes("quanto custa")
  ) {
    return {
      replyText: `Olá, ${contactName}! Nossos serviços principais variam conforme a sua necessidade. Poderia me detalhar brevemente o que você procura para eu te passar a estimativa correta?`,
      intencao: "interesse_comercial",
      resumo: "Cliente demonstrou interesse comercial e solicitou informações de valores.",
    };
  }

  if (
    lower.includes("olá") ||
    lower.includes("ola") ||
    lower.includes("bom dia") ||
    lower.includes("boa tarde") ||
    lower.includes("boa noite")
  ) {
    return {
      replyText: `Olá, ${contactName}! Seja bem-vindo(a). Sou o atendente virtual da empresa. Como posso te ajudar hoje?`,
      intencao: "saudacao_inicial",
      resumo: "Contato iniciou conversa com saudação.",
    };
  }

  return {
    replyText: `Compreendi perfeitamente, ${contactName}. Já anotei essas informações no seu cadastro e nossa equipe também tem acesso ao histórico. Gostaria de verificar opções de agendamento ou tirar alguma dúvida?`,
    intencao: "atendimento_geral",
    resumo: "Atendimento padrão registrado sem pendência crítica.",
  };
}

// -----------------------------------------------------------------------------
// Resolução ou Criação do Contato de Teste
// -----------------------------------------------------------------------------

async function resolverContatoDeTeste(
  supabase: SupabaseClient,
  organizationId: string,
  actorUserId: string,
  contactInput?: SimulatorMessageInput["contact"],
): Promise<{ id: string; name: string; phone_number: string }> {
  if (contactInput?.id) {
    const { data: existing, error } = await supabase
      .from("contacts")
      .select("id, name, phone_number")
      .eq("organization_id", organizationId)
      .eq("id", contactInput.id)
      .maybeSingle();

    if (error) {
      throw new Error(`Erro ao consultar contato de teste: ${error.message}`);
    }

    if (existing) {
      return {
        id: existing.id,
        name: existing.name ?? "Lead de Teste",
        phone_number: existing.phone_number ?? "+5511999990001",
      };
    }
  }

  const phone = contactInput?.phone_number ?? "+5511999990001";
  const name = contactInput?.name ?? "Lead de Teste (Simulador)";

  // Tenta localizar por telefone na mesma organização
  const { data: porTelefone, error: telErr } = await supabase
    .from("contacts")
    .select("id, name, phone_number")
    .eq("organization_id", organizationId)
    .eq("phone_number", phone)
    .maybeSingle();

  if (telErr) {
    throw new Error(`Erro ao buscar contato por telefone: ${telErr.message}`);
  }

  if (porTelefone) {
    return {
      id: porTelefone.id,
      name: porTelefone.name ?? name,
      phone_number: phone,
    };
  }

  // Cria contato com tag reservada de simulação
  const { data: criado, error: insErr } = await supabase
    .from("contacts")
    .insert({
      organization_id: organizationId,
      name,
      phone_number: phone,
      tags: ["atendepro_simulado"],
      source: "simulator",
      source_metadata: {
        simulated: true,
        created_by_actor: actorUserId,
      },
    })
    .select("id, name, phone_number")
    .single();

  if (insErr || !criado) {
    if (insErr?.code === "23505") {
      const { data: vencedor, error: retryErr } = await supabase
        .from("contacts")
        .select("id, name, phone_number")
        .eq("organization_id", organizationId)
        .eq("phone_number", phone)
        .maybeSingle();
      if (retryErr) {
        throw new Error(`Falha ao resolver contato de teste após corrida: ${retryErr.message}`);
      }
      if (vencedor) {
        return {
          id: vencedor.id,
          name: vencedor.name ?? name,
          phone_number: vencedor.phone_number ?? phone,
        };
      }
    }
    throw new Error(`Falha ao criar contato de teste no simulador: ${insErr?.message}`);
  }

  return {
    id: criado.id,
    name: criado.name ?? name,
    phone_number: criado.phone_number ?? phone,
  };
}

// -----------------------------------------------------------------------------
// Resolução da Sessão de Canal do Simulador (Migration 0239)
// -----------------------------------------------------------------------------

async function resolverSessaoSimulador(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ channelSessionId: string }> {
  // Chave determinística por organização exigida pela migration 0239
  const simulatorSessionKey = `atendepro-local-${organizationId}`;

  // 1. Tenta localizar a sessão com provider='simulator' e simulator_session_key da org
  const { data: existente, error: findErr } = await supabase
    .from("channel_sessions")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", "simulator")
    .eq("simulator_session_key", simulatorSessionKey)
    .maybeSingle();

  if (findErr) {
    // Se a coluna simulator_session_key não existe, a migration 0239 ainda não foi aplicada
    if (findErr.message.includes("simulator_session_key")) {
      throw new MigrationPendingError(
        "A migration 20260913160000_0239_canal_simulador_local.sql ainda não foi aplicada ao banco (coluna simulator_session_key ausente).",
        findErr.message,
      );
    }
    throw new Error(`Erro ao verificar channel_sessions do simulador: ${findErr.message}`);
  }

  if (existente?.id) {
    return { channelSessionId: existente.id };
  }

  // 2. Inserção determinística da sessão conforme contrato da migration 0239:
  //    - provider = 'simulator'
  //    - simulator_session_key = 'atendepro-local-<org>'
  //    - sem referencia de transporte externo
  //    - status = 'WORKING'
  const { data: criada, error: insErr } = await supabase
    .from("channel_sessions")
    .insert({
      organization_id: organizationId,
      provider: "simulator",
      simulator_session_key: simulatorSessionKey,
      status: "WORKING",
      display_name: "Canal Simulado Local (AtendePro)",
      webhook_secret_encrypted: "\\x00",
      metadata: {
        simulated: true,
        zero_egress: true,
        atendepro: true,
      },
    })
    .select("id")
    .maybeSingle();

  if (criada?.id) {
    return { channelSessionId: criada.id };
  }

  // 3. Se falhar, falha fechado (sem fallback para sessões WhatsApp)
  if (insErr) {
    // Duas primeiras mensagens simultâneas podem passar pelo SELECT acima.
    // O índice único da migration decide o vencedor; a segunda requisição
    // deve reutilizar a sessão vencedora, nunca cair para WhatsApp nem falhar
    // com um 500 espúrio.
    if (insErr.code === "23505") {
      const { data: vencedora, error: retryErr } = await supabase
        .from("channel_sessions")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("provider", "simulator")
        .eq("simulator_session_key", simulatorSessionKey)
        .maybeSingle();

      if (retryErr) {
        throw new Error(
          `Falha ao resolver sessÃ£o do simulador apÃ³s corrida: ${retryErr.message}`,
        );
      }
      if (vencedora?.id) return { channelSessionId: vencedora.id };
    }

    const isConstraintError =
      insErr.message.includes("channel_sessions_provider_check") ||
      insErr.message.includes("channel_sessions_provider_ref_check") ||
      insErr.message.includes("simulator_session_key") ||
      insErr.code === "23514";

    if (isConstraintError) {
      throw new MigrationPendingError(
        "A migration 20260913160000_0239_canal_simulador_local.sql ainda não foi aplicada ao banco (constraints de provider bloqueando 'simulator').",
        insErr.message,
      );
    }

    throw new Error(`Falha ao criar sessão do simulador no banco: ${insErr.message}`);
  }

  throw new Error("Não foi possível resolver a sessão do canal simulador.");
}

// -----------------------------------------------------------------------------
// Resolução ou Criação da Conversa no Canal Simulator
// -----------------------------------------------------------------------------

async function resolverConversa(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  channelSessionId: string,
  conversationId?: string,
  requestId?: string,
): Promise<{ id: string }> {
  if (conversationId) {
    const { data: existente, error: convErr } = await supabase
      .from("conversations")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("id", conversationId)
      .eq("contact_id", contactId)
      .eq("channel_session_id", channelSessionId)
      .eq("channel", "simulator")
      .maybeSingle();

    if (convErr) {
      throw new Error(`Erro ao buscar conversa por ID: ${convErr.message}`);
    }

    if (!existente) {
      throw new ApiError(
        404,
        "not_found",
        undefined,
        requestId ?? "simulator",
        "Conversa simulada não encontrada nesta organização.",
      );
    }
    return { id: existente.id };
  }

  // Procura conversa aberta existente para o contato no canal simulator
  const { data: aberta, error: findErr } = await supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", channelSessionId)
    .eq("channel", "simulator")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (findErr) {
    throw new Error(`Erro ao buscar conversa aberta: ${findErr.message}`);
  }

  if (aberta) return { id: aberta.id };

  // Cria conversa estritamente com channel='simulator' (sem fallback para whatsapp)
  const agoraIso = new Date().toISOString();

  const { data: criada, error: insErr } = await supabase
    .from("conversations")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      channel_session_id: channelSessionId,
      channel: "simulator",
      status: "open",
      metadata: {
        simulated: true,
        origin: "atendepro_simulator",
      },
      last_inbound_at: agoraIso,
      last_message_at: agoraIso,
    })
    .select("id")
    .maybeSingle();

  if (insErr || !criada) {
    if (insErr?.code === "23505") {
      const { data: vencedor, error: retryErr } = await supabase
        .from("conversations")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("channel_session_id", channelSessionId)
        .eq("channel", "simulator")
        .maybeSingle();
      if (retryErr) {
        throw new Error(`Falha ao resolver conversa simulada após corrida: ${retryErr.message}`);
      }
      if (vencedor) return { id: vencedor.id };
    }
    if (insErr?.message?.includes("conversations_channel_check") || insErr?.code === "23514") {
      throw new MigrationPendingError(
        "A migration 20260913160000_0239_canal_simulador_local.sql ainda não foi aplicada ao banco (conversations_channel_check bloqueando 'simulator').",
        insErr?.message,
      );
    }
    throw new Error(`Falha ao criar conversa simulada no canal 'simulator': ${insErr?.message}`);
  }

  return { id: criada.id };
}

// -----------------------------------------------------------------------------
// Função Principal do Runtime do Simulador
// -----------------------------------------------------------------------------

export async function executeSimulatorTurn(
  input: SimulatorMessageInput,
  opts: SimulatorTurnOptions,
): Promise<SimulatorTurnResult> {
  const startedAt = new Date();
  const supabase = opts.supabase ?? createAdminClient();
  const { organizationId, actorUserId, requestId } = opts;

  // 1. Resolve ou cria Contato de Teste
  const contato = await resolverContatoDeTeste(
    supabase,
    organizationId,
    actorUserId,
    input.contact,
  );

  // 2. Resolve Sessão de Canal 'simulator' (falha fechado com MigrationPendingError se constraint bloquear)
  const { channelSessionId } = await resolverSessaoSimulador(supabase, organizationId);

  // 3. Resolve ou cria Conversa com channel='simulator' (sem fallback para whatsapp)
  const conversa = await resolverConversa(
    supabase,
    organizationId,
    contato.id,
    channelSessionId,
    input.conversation_id,
    requestId,
  );

  const agoraIso = startedAt.toISOString();

  // 4. Persiste mensagem INBOUND usando apenas colunas reais (sem sender_type)
  const { data: inboundRow, error: inErr } = await supabase
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversa.id,
      contact_id: contato.id,
      channel_session_id: channelSessionId,
      direction: "inbound",
      status: "received",
      type: "text",
      sent_via: "user",
      body: input.body,
      metadata: {
        simulated: true,
        actor_user_id: actorUserId,
        client: "atendepro_simulator",
      },
      sent_at: agoraIso,
    })
    .select("id, body, direction, status, sent_via, sent_at")
    .single();

  if (inErr || !inboundRow) {
    throw new Error(`Erro ao persistir mensagem inbound simulada: ${inErr?.message}`);
  }

  // 5. Execução do modelo determinístico (sem rede externa)
  const { replyText, intencao, resumo } = gerarRespostaDeterministica(
    input.body,
    input.scenario,
    contato.name,
  );

  // 6. Mutação opcional de Lead (Portas abertas para crm_create_lead e crm_move_lead_stage auditáveis)
  let leadMutation: SimulatorTurnResult["lead_mutation"];

  if (input.lead_action) {
    const handlerCtx = {
      organization_id: organizationId,
      actor: { type: "user" as const, id: actorUserId, role: "agent" as const },
      requestId,
    };

    if (
      input.lead_action.action === "create" &&
      input.lead_action.pipeline_id &&
      input.lead_action.stage_id
    ) {
      const createPayload: CreateLeadInput = {
        pipeline_id: input.lead_action.pipeline_id,
        stage_id: input.lead_action.stage_id,
        title: input.lead_action.title ?? `Oportunidade - ${contato.name}`,
        currency: "BRL",
        contact_id: contato.id,
        source: "atendepro_simulator",
        tags: ["simulado"],
      };

      const createdLead = await createLeadHandler(supabase, handlerCtx, createPayload);
      leadMutation = { action: "created", lead: createdLead };

      await audit({
        action: "lead.created",
        actorUserId,
        organizationId,
        resourceType: "crm_lead",
        resourceId: String(createdLead.id ?? ""),
        requestId,
        metadata: { simulated: true, origin: "atendepro_simulator" },
      });
    } else if (
      input.lead_action.action === "move_stage" &&
      input.lead_action.lead_id &&
      input.lead_action.stage_id
    ) {
      const movedLead = await moveLeadHandler(supabase, handlerCtx, input.lead_action.lead_id, {
        to_stage_id: input.lead_action.stage_id,
        reason: input.lead_action.reason ?? "Avanço automático simulado pelo AtendePro",
      });
      leadMutation = { action: "moved", lead: movedLead };

      await audit({
        action: "lead.moved",
        actorUserId,
        organizationId,
        resourceType: "crm_lead",
        resourceId: input.lead_action.lead_id,
        requestId,
        metadata: { simulated: true, to_stage_id: input.lead_action.stage_id },
      });
    }
  }

  const outboundIso = new Date().toISOString();

  // 7. Persiste mensagem OUTBOUND usando apenas colunas reais (sem sender_type)
  const { data: outboundRow, error: outErr } = await supabase
    .from("messages")
    .insert({
      organization_id: organizationId,
      conversation_id: conversa.id,
      contact_id: contato.id,
      channel_session_id: channelSessionId,
      direction: "outbound",
      status: "delivered",
      type: "text",
      sent_via: "ai",
      body: replyText,
      metadata: {
        simulated: true,
        zero_egress: true,
        scenario: input.scenario,
        intencao_detectada: intencao,
        lead_mutation_performed: Boolean(leadMutation),
      },
      sent_at: outboundIso,
    })
    .select("id, body, direction, status, sent_via, sent_at")
    .single();

  if (outErr || !outboundRow) {
    throw new Error(`Erro ao persistir mensagem outbound simulada: ${outErr?.message}`);
  }

  // 8. Atualiza timestamps da conversa (com filtro de organization_id)
  const { error: conversaUpdateErr } = await supabase
    .from("conversations")
    .update({
      last_inbound_at: agoraIso,
      last_message_at: outboundIso,
      last_outbound_at: outboundIso,
      last_message_preview: replyText.slice(0, 100),
      updated_at: outboundIso,
    })
    .eq("id", conversa.id)
    .eq("organization_id", organizationId);
  if (conversaUpdateErr) {
    throw new Error(`Erro ao atualizar conversa simulada: ${conversaUpdateErr.message}`);
  }

  // 9. Registro em ai_agent_runs com is_dry_run = false (se houver agente cadastrado na organização)
  const { data: agenteAtivo } = await supabase
    .from("ai_agents")
    .select("id, published_version_id")
    .eq("organization_id", organizationId)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (agenteAtivo?.published_version_id) {
    await supabase.from("ai_agent_runs").insert({
      organization_id: organizationId,
      agent_id: agenteAtivo.id,
      agent_version_id: agenteAtivo.published_version_id,
      conversation_id: conversa.id,
      contact_id: contato.id,
      channel_session_id: channelSessionId,
      inbound_message_id: inboundRow.id,
      outbound_message_id: outboundRow.id,
      status: "completed",
      is_dry_run: false, // Simulação persistente auditada com is_dry_run=false
      cost_cents: 0,
      tokens_in: input.body.length,
      tokens_out: replyText.length,
      steps_count: 1,
      tool_calls: leadMutation ? [leadMutation] : [],
      started_at: agoraIso,
      completed_at: outboundIso,
      latency_ms: Date.now() - startedAt.getTime(),
    });
  }

  // 10. Auditoria de execução do teste
  await audit({
    action: "ai_agent.tested",
    actorUserId,
    organizationId,
    resourceType: "conversations",
    resourceId: conversa.id,
    requestId,
    metadata: {
      simulated: true,
      zero_egress: true,
      channel: "simulator",
      inbound_id: inboundRow.id,
      outbound_id: outboundRow.id,
      intencao,
      lead_action: input.lead_action?.action ?? null,
    },
  });

  return {
    conversation_id: conversa.id,
    contact_id: contato.id,
    channel_session_id: channelSessionId,
    inbound_message: {
      id: inboundRow.id,
      body: inboundRow.body ?? input.body,
      direction: "inbound",
      status: "received",
      sent_via: "user",
      sent_at: inboundRow.sent_at,
    },
    outbound_message: {
      id: outboundRow.id,
      body: outboundRow.body ?? replyText,
      direction: "outbound",
      status: "delivered",
      sent_via: "ai",
      sent_at: outboundRow.sent_at,
    },
    declaration: {
      nada_a_declarar: false,
      intencao_detectada: intencao,
      resumo,
    },
    lead_mutation: leadMutation,
  };
}

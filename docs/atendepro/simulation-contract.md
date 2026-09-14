# Contrato do Runtime Simulado — Fatia Vertical AtendePro

> Precedência: `contract-cross-review.md` é a reconciliação canônica para schema, provider `simulator`, persistência e auditoria. Este contrato não autoriza fallback para WhatsApp nem trata preview dry-run como persistência.

- **Documento:** `docs/atendepro/simulation-contract.md`
- **Data:** 2026-09-13
- **Fase:** Contratos de Arquitetura da Primeira Fatia Vertical
- **Especialista Líder:** **Duna** (Agentes Nativos, RAG, MCP e Simulação)
- **Cruzamento Multidisciplinar:**
  - **Aurora:** Arquitetura e Integração com o núcleo DeskcommCRM
  - **Cometa:** CRM, Onboarding e Fluxos Operacionais
  - **Eclipse:** QA, Invariantes, E2E e Determinismo
  - **Fenix:** Segurança, Zero Egress, RLS, RBAC e Auditoria
  - **Boreal:** UX e Consumo na Interface do Simulador

---

## 1. Objetivo e Escopo da Fatia Vertical

O objetivo do AtendePro é entregar uma experiência simplificada para pequenos negócios que atendem por mensagem ([`docs/atendepro/project-brief.md`](file:///mnt/c/teste/DeskcommCRM-canonical/docs/atendepro/project-brief.md)), mantendo todo o motor do DeskcommCRM nos bastidores ([`docs/atendepro/decisions.md`](file:///mnt/c/teste/DeskcommCRM-canonical/docs/atendepro/decisions.md#L3-L6)).

A primeira fatia vertical cobre o ciclo completo:
$$\text{Onboarding do Negócio} \longrightarrow \text{Configuração do Atendente} \longrightarrow \text{Conversa Simulada} \longrightarrow \text{Ação Auditada no CRM}$$

Este documento formaliza o **Contrato do Runtime Simulado**, que viabiliza a execução da conversa interativa sem dependência de WhatsApp real, sem contratação de serviços pagos, sem egress de rede e com total persistência e auditabilidade no CRM local.

---

## 2. Princípios Inegociáveis do Runtime Simulado

1. **Zero Egress Externo (Fenix & Duna):**
   Nenhum byte de rede pode sair para provedores de mensageria (WhatsApp/WAHA/Meta/Zernio) nem requisições externas obrigatórias de IA/Embeddings durante a simulação local.
2. **Reúso Estrito das Entidades Canônicas (Aurora & Cometa — D-001):**
   A simulação não cria tabelas paralelas nem duplica tabelas de contatos, conversas, mensagens, funis ou agendamentos. Reutiliza `contacts`, `conversations`, `messages`, `crm_leads`, `crm_appointments` e `crm_lead_activities`.
3. **Persistência Real no CRM com Tagging de Simulação (Cometa & Fenix):**
   Diferente do preview de prompt que descarta IDs (`contactId: null`), a conversa simulada do AtendePro cria registros reais no banco da organização de teste, permitindo que a interface do CRM (Kanban, Timeline, Agenda) reflita imediatamente a conversa.
4. **Determinismo e Repetibilidade (Eclipse):**
   Os cenários de teste devem ser executáveis sem flakiness, suportando modo scriptado (mock determinístico) para validação de regressão contínua em CI e desenvolvimento local.
5. **Isolamento de Tenant e RLS (Fenix):**
   Toda leitura e mutação é restrita ao `organization_id` da organização de teste, validada pela sessão autenticada ou closure de job seguro, sem permissão de override por payload.

---

## 3. Contrato de Entrada do Cliente (Simulated Inbound Message)

### 3.1. Ponto de Entrada da Mensagem Simulada
A entrada de mensagens enviadas pelo usuário testador na interface do AtendePro segue o mesmo fluxo semântico de uma mensagem recebida via canal externo, porém através de uma rota de simulação autenticada:

- **Rota:** `POST /api/v1/simulator/messages`
- **Autenticação:** Sessão ativa (`auth_user`) com papel mínimo `admin` ou `agent` na organização.
- **Payload Schema (Zod):**

```typescript
export const simulatedInboundSchema = z.object({
  /** ID da conversa simulada (se omitido, uma nova é criada ou recuperada para o contato) */
  conversation_id: z.string().uuid().optional(),
  /** Dados do contato simulado (lead de teste) */
  contact: z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(120),
    phone: z.string().min(8).max(20).default('+5511999990001'),
  }),
  /** Conteúdo da mensagem simulada */
  message: z.object({
    body: z.string().min(1).max(4096),
    type: z.literal('text').default('text'),
    sent_at: z.string().datetime().optional(),
  }),
  /** Opções de execução */
  options: z.object({
    /** Cenário de mock determinístico opcional */
    scenario_id: z.string().optional(),
    /** Forçar execução síncrona para feedback imediato no chat de teste */
    sync: z.boolean().default(true),
  }).optional(),
}).strict();
```

### 3.2. Ciclo de Ingestão e Preparação no CRM
Ao receber a mensagem simulada:
1. **Resolução de Contato:**
   Localiza ou insere o contato em `contacts` com `organization_id = ctx.organizationId`, associando a tag identificadora `simulado`.
2. **Resolução de Sessão de Canal:**
   Garante a existência de uma sessão em `channel_sessions` com `provider = 'simulator'`, `status = 'WORKING'` e `is_active = true`.
3. **Criação da Linha da Mensagem:**
   Grava em `messages` com:
   - `direction = 'inbound'`
   - `sender_type = 'contact'`
   - `status = 'delivered'`
   - `channel_session_id = session.id`
   - `metadata = { simulated: true, scenario_id: ... }`
4. **Disparo do Turno do Agente:**
   Envia o evento para processamento pelo motor canônico do agente ([`executarTurnoDoAgente`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/agent-engine/agent/inbound-turn.ts#L1507)).

---

## 4. O Canal e Adaptador Simulado (`simulator`)

### 4.1. Extensão do Seam de Canais ([`lib/channels`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/channels/index.ts))
Para cumprir a garantia de **Zero Egress** sem quebrar a tipagem de [`ChannelProvider`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/channels/types.ts#L12), o seam de canais incorpora formalmente o provider `simulator`:

```typescript
export type ChannelProvider = "waha" | "meta_cloud" | "zernio" | "wacalls" | "simulator";
```

### 4.2. Especificação do `simulatorAdapter`
O adaptador simulado implementa a interface canônica `ChannelAdapter`:

| Propriedade / Método | Comportamento no Simulador | Justificativa / Proteção |
|---|---|---|
| `isConfigured()` | Sempre retorna `true`. | Não depende de variáveis de ambiente de terceiros ou QR codes. |
| `resolveRecipient()` | Retorna `sim:${phoneNumber}`. | Garante que o destinatário nunca tenha sintaxe aceita por gateways reais. |
| `capabilities` | `{ freeformOutsideWindow: true, requiresTemplates: false, canManageTemplates: false, banRisk: false, minIntervalMs: null, voiceNote: 'server-convert', groups: 'none', costPerMessage: false }` | Sem restrições de janela de 24h ou custos de mensagem durante testes. |
| `send(envelope)` | **Interceptador puro sem I/O de rede externa.**<br>1. Gera `externalId = 'sim-msg-' + randomUUID()`.<br>2. Registra o envio como concluído.<br>3. Emite evento local (SSE/WebSocket/BroadcastChannel) para a UI do AtendePro. | **Garantia Fenix:** Zero chamadas `fetch()` para IPs externos. Impossível disparar mensagens acidentais. |
| `sendTemplate()` | Não aplicável (cai em fallback gracioso de texto). | Simulação foca em conversa natural. |

---

## 5. Mock Determinístico de LLM (Zero Custo & Zero Rede)

### 5.1. Arquitetura do Mock
O runtime simulado utiliza o mecanismo canônico [`createFakeRegistry`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/agent-engine/edge/llm/providers.ts#L126-L146), instanciando modelos `MockLanguageModelV3` que interpretam o histórico e retornam chamadas de ferramenta ou textos controlados.

### 5.2. Cenários Padrão para a Primeira Fatia Vertical
Para validação local imediata (Eclipse & QA), o mock determinístico oferece três cenários chave:

#### Cenário 1: "Agendamento Direto de Consulta/Serviço" (Happy Path)
1. **Entrada do Usuário:** *"Olá, gostaria de agendar uma consulta para amanhã à tarde."*
2. **Turno 1 (Conversador):**
   - Invoca: `search_knowledge` (opcional).
   - Resposta ao cliente: *"Com certeza! Tenho horário disponível amanhã às 14:00 e às 16:00. Qual prefere?"*
   - Declaração de intenção:
     ```json
     {
       "nada_a_declarar": false,
       "avanco_de_estagio": "qualificado",
       "compromissos": [{ "descricao": "Ofereceu horários de 14h e 16h para amanhã" }]
     }
     ```
3. **Turno 2 (Operador — Desencadeado automaticamente):**
   - Invoca ferramenta MCP: `crm_find_free_slots` e `crm_move_lead_stage(stage: 'qualificado')`.
   - Registra atividade auditada na timeline: `crm_lead_activities`.

#### Cenário 2: "Confirmação de Horário e Conclusão"
1. **Entrada do Usuário:** *"Pode ser às 14:00."*
2. **Turno 1 (Conversador):**
   - Resposta ao cliente: *"Perfeito! Seu agendamento foi confirmado para amanhã às 14:00. Te esperamos lá!"*
   - Declaração de intenção:
     ```json
     {
       "nada_a_declarar": false,
       "avanco_de_estagio": "agendado",
       "agendamento_confirmado": {
         "data_hora": "2026-09-14T14:00:00-03:00",
         "servico": "Atendimento Geral"
       }
     }
     ```
3. **Turno 2 (Operador):**
   - Invoca ferramenta MCP: `crm_book_appointment(...)`.
   - Invoca ferramenta MCP: `crm_move_lead_stage(stage: 'agendado')`.
   - Emite evento no CRM: Agendamento visível na Agenda e Card movido no Kanban.

#### Cenário 3: "Dúvida de Preço e Serviços"
1. **Entrada do Usuário:** *"Quais serviços vocês oferecem e quais são os valores?"*
2. **Turno 1 (Conversador):**
   - Resposta ao cliente com base nos dados do negócio configurados no onboarding do AtendePro.

---

## 6. RAG Opcional e Degradação Graciosa (Fallback)

### 6.1. O Problema Identificado na Auditoria
O RAG canônico ([`lib/ai/embed.ts`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/ai/embed.ts#L48-L68)) lança `SemChaveDeEmbeddingError` se a chave `OPENAI_API_KEY` não existir e falha se a extensão PostgreSQL `pgvector` não estiver ativa.

### 6.2. Estratégia de Fallback Seguro no Simulador
1. **Injeção de Embeddings Falsos em Testes:**
   Em modo de simulação/teste local, o resolvedor de embeddings injeta um gerador determinístico in-memory:
   ```typescript
   export const fakeEmbedText = async (text: string) => ({
     embedding: Array(1536).fill(0.1),
     promptTokens: 0,
     model: "text-embedding-3-small",
   });
   ```
2. **Fallback Textual para Dados Básicos do Negócio:**
   Para as informações cadastradas no onboarding do AtendePro (serviços, preços, horários de funcionamento):
   - Os dados são injetados diretamente no prompt de sistema do agente via template declarativo (`system_prompt`), **sem exigir indexação vetorial prévia**.
3. **Busca Tolerante à Falha:**
   Caso `search_knowledge` seja executado e o acervo esteja vazio ou sem vetores, o handler retorna:
   ```json
   { "ok": true, "results": [] }
   ```
   O modelo é instruído a responder com base nas diretrizes do negócio contidas no prompt principal, sem abortar o atendimento.

---

## 7. Ferramentas MCP Permitidas para a Fatia Vertical

Seguindo a doutrina de separação estrita ([`HANDOFF-tres-papeis.md`](file:///mnt/c/teste/DeskcommCRM-canonical/HANDOFF-tres-papeis.md)), as ferramentas são rigorosamente isoladas por papel:

```
┌─────────────────────────────────────────────────────────────┐
│                 PRIMEIRA FATIA ATENDEPRO                     │
├──────────────────────────────┬──────────────────────────────┤
│    CONVERSADOR (Turno 1)     │     OPERADOR (Turno 2)       │
│      (Fala com o Lead)       │     (Mutações no CRM)        │
├──────────────────────────────┼──────────────────────────────┤
│ • search_knowledge (leitura) │ • crm_find_free_slots (read) │
│ • read_skill_reference (read)│ • crm_list_event_types (read)│
│ • get_lead_context (read)    │ • crm_book_appointment (w)  │
│ • send_message (saída)       │ • crm_reschedule_appointment│
│                              │ • crm_create_lead (write)    │
│                              │ • crm_move_lead_stage (write)│
│                              │ • crm_request_human_handoff  │
├──────────────────────────────┴──────────────────────────────┤
│ ⚠️ Regra Dura: Conversador NUNCA recebe tools de escrita.   │
│ ⚠️ Regra Dura: Operador NUNCA recebe `send_message`.        │
└─────────────────────────────────────────────────────────────┘
```

### 7.1. Higienização Mandatória
Toda chamada de ferramenta do Operador passa por [`higienizarUuidsDeAterro`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/mcp/uuid-de-aterro.ts) para eliminar sentinelas (`00000000-0000-0000-0000-000000000000`) e por [`podeChamarFerramenta`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/leads/escopo-de-funil.ts) para travar o escopo do funil.

---

## 8. Persistência no CRM vs. Modo Dry-Run

O DeskcommCRM agora distingue com clareza dois modos de teste:

| Característica | Modo Dry-Run (Unitário / Preview) | Modo Simulado Persistente (AtendePro Slice) |
|---|---|---|
| **Ponto de Entrada** | `POST .../versions/:vid/test` | `POST /api/v1/simulator/messages` |
| **Identificador de Contato** | `contactId: null` (cenário volátil) | `contactId` real gerado no banco |
| **Conversa e Mensagens** | Descartadas ao término do request | Salvas em `conversations` e `messages` |
| **Card no Kanban (Lead)** | Apenas proposta em JSON (`proposal_only`) | Card criado/movido em `crm_leads` |
| **Agendamento** | Apenas proposta em JSON | Linha gravada em `crm_appointments` |
| **Timeline de Atividades** | Não gera atividades | Grava em `crm_lead_activities` |
| **Rede WhatsApp** | Zero Egress | **Zero Egress** (Canal `simulator`) |
| **Objetivo** | Testar prompt/regex isolado | **Validar fluxo de negócio completo na UI** |

---

## 9. Identificadores, Metadados e Rastreabilidade

Para que o teste local seja rastreável e reversível:

1. **Tag de Isolamento:** Todo contato criado pelo simulador recebe a tag do sistema `atendepro_simulado`.
2. **Origem da Conversa:** `conversations.metadata->>'origin'` é marcado como `'atendepro_simulator'`.
3. **Auditoria de Ações:**
   - Cada chamada de ferramenta MCP gera registro em `api_audit_log` com `actor_role = 'agent'` e `success = true|false`.
   - Cada ciclo de execução gera registro em `ai_agent_runs` com as métricas de latência e contagem de passos.
4. **Limpeza de Testes (Idempotência / Reset):**
   O contrato prevê uma operação idempotente para resetar dados da simulação da organização de teste sem tocar em outras organizações:
   - `DELETE FROM conversations WHERE channel_session_id IN (SELECT id FROM channel_sessions WHERE provider = 'simulator' AND organization_id = :orgId)`.

---

## 10. Matriz de Responsabilidades do Maestri no Contrato

| Papel | Responsabilidade no Cumprimento deste Contrato |
|---|---|
| **Aurora (Arquitetura)** | Garantir que o `simulatorAdapter` se encaixe no seam [`lib/channels/index.ts`](file:///mnt/c/teste/DeskcommCRM-canonical/lib/channels/index.ts) sem modificar o comportamento dos canais de produção e assegurar compatibilidade com o pool PostgreSQL. |
| **Cometa (CRM)** | Validar que a movimentação do lead e a criação do agendamento reflitam instantaneamente no Kanban e na Agenda da UI do DeskcommCRM. |
| **Duna (IA & Simulação)** | Manter os cenários do mock determinístico calibrados com a linguagem leiga e garantir que a declaração do Conversador seja traduzida fielmente em ações pelo Operador. |
| **Eclipse (QA & Testes)** | Criar a suíte de testes de integração automatizados (`vitest`) cobrindo os 3 cenários do simulador com asserções de banco e zero chamadas externas. |
| **Fenix (Segurança)** | Auditar o código do adaptador simulado para certificar ausência de chamadas HTTP salientes e validar RLS em todas as tabelas afetadas. |
| **Boreal (UX)** | Desenhar o painel do simulador (chat interativo lado a lado com a visualização do card do CRM) consumindo este contrato. |

---

## 11. Critérios de Aceite da Primeira Fatia (Definition of Done)

1. [ ] Uma mensagem simulada enviada pela rota de simulação é persistida no banco local em `messages`.
2. [ ] O Conversador responde com texto natural amigável sem vazar termos de sistema (`crm_*`, `role`, `uuid`).
3. [ ] A declaração do Conversador aciona o Operador em segundo plano.
4. [ ] O Operador move o lead no funil ou cria o agendamento em `crm_appointments`.
5. [ ] Toda a execução roda localmente com banco de teste, sem requisições para a internet, com chaves mockadas e zero chamadas para WhatsApp real.
6. [ ] A suíte de testes do Eclipse passa 100% verde e sem flaky tests.

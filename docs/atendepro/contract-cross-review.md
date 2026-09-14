# AtendePro — Revisão Cruzada dos Contratos

> Revisão do Maestro contra o baseline `ca2eb0a`, realizada em 2026-09-13.
> Este arquivo consolida as decisões que prevalecem quando os contratos das
> frentes divergem. Nenhuma alteração de código ou banco foi feita nesta revisão.

## 1. Decisões canônicas

### 1.1 Entidades e rotas

O AtendePro reutiliza exclusivamente as entidades existentes:

| Finalidade                   | Entidade canônica                                                 | Entrada existente                    |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| Contatos                     | `contacts`                                                        | `/api/v1/contacts`                   |
| Funis e leads                | `crm_pipelines`, `crm_stages`, `crm_leads`, `crm_lead_activities` | `/api/v1/pipelines`, `/api/v1/leads` |
| Tipos de serviço/agendamento | `calendar_event_types`                                            | `/api/v1/agenda/tipos`               |
| Compromissos                 | `calendar_appointments`                                           | `/api/v1/agenda/agendamentos`        |
| Catálogo de itens com preço  | `catalog_products`                                                | `/api/v1/products`                   |
| Auditoria                    | `api_audit_log`                                                   | `lib/audit/index.ts`                 |

Os nomes `agenda_services`, `agenda_appointments`, `crm_appointments`,
`crm_products` e `audit_logs` não são contratos do repositório e não podem
aparecer em código novo ou nos testes da fatia.

O preço de `calendar_event_types` continua uma lacuna real: a tabela possui
duração, categoria e disponibilidade, mas não preço. `catalog_products` é o
catálogo de itens/SKUs e não deve ser usado como vínculo implícito de serviço.
Na primeira fatia, preço de serviço fica nas diretrizes/memória do negócio ou
na descrição do tipo de evento. A adição de preço estruturado será uma decisão
de migration posterior.

### 1.2 Dois modos de teste, sem mistura

1. **Preview de prompt existente** —
   `POST /api/v1/ai/agents/:id/versions/:vid/test`, com `is_dry_run: true`.
   Continua sem contato, conversa, mensagens ou mutações CRM. Serve para
   conferir prompt e guardrails.
2. **Simulador persistente AtendePro** — nova entrada autenticada para a
   conversa multirrodada. Persiste dados marcados como teste e executa as
   mutações canônicas permitidas, para que Inbox, Funil, Agenda e Timeline
   mostrem a jornada completa.

O segundo modo não deve chamar-se dry-run nem reutilizar a política
`preview_no_client_effects`. Seus `ai_agent_runs` devem carregar
`is_dry_run: false` e metadata de simulação, mantendo a distinção auditável.

### 1.3 Canal sintético e zero-egress

O provider canônico da nova camada é o literal `simulator`. O adjetivo
`simulated` pode aparecer em metadata, mas não como segundo nome do provider.

O baseline atual ainda restringe `channel_sessions.provider` a `waha`,
`meta_cloud`, `zernio` e `wacalls`, e restringe `conversations.channel` a
`whatsapp`. Portanto, a implementação do simulador persistente depende de uma
migration aditiva que:

- acrescente o ramo `simulator` às constraints;
- forneça uma referência sintética própria para a sessão, sem preencher
  `waha_session_name`;
- aceite `conversations.channel = 'simulator'`;
- não altere o comportamento dos quatro providers de produção;
- deixe o watchdog/redrive de WAHA fora das sessões do simulador.

É proibido representar o simulador como `provider = 'waha'`, como
`waha_session_name = 'sim-atendepro'` ou como uma sessão real sem credenciais.
Isso confundiria a reconciliação e poderia transformar uma mensagem de teste em
tráfego real.

O adapter do simulador é in-process: grava o outbound localmente e devolve um
identificador sintético. Ele não instancia cliente WAHA/Meta/Zernio, não faz
`fetch` externo e falha fechado se receber uma operação de transporte externo.

### 1.4 Schema de mensagens e autoria

`messages` não possui `sender_type`. O contrato usa apenas as colunas reais:
`direction`, `status`, `type`, `sent_via`, `body`, `metadata` e os IDs de
organização/conversa/sessão/contato. A implementação deve seguir os valores e
transições já aceitos pelo CHECK da tabela e identificar o cenário em metadata.

`api_audit_log` também não possui `actor_kind`. A autoria é representada pelo
`actor_user_id`/`request_id` e metadata do evento. Quando houver atividade do
lead, `crm_lead_activities.actor_kind = 'ai'`; para o compromisso,
`calendar_appointments.created_by_kind = 'ai'`. Os eventos devem usar somente
o union de `lib/audit/actions.ts`, em especial `ai_agent.tested`,
`mcp.tool_called`, `lead.created`, `lead.moved`, `agenda.appointment_created`
e os eventos de onboarding já existentes.

### 1.5 Onboarding e preset

O banco e o schema de navegação aceitam somente `preset: 'completa'` ou
`preset: 'simplificada'`. Não será criado um preset `atendepro`.

O AtendePro usa `simplificada` com uma lista de destinos que preserve a
configuração necessária ao primeiro uso, incluindo a fachada do negócio,
agente e tipos de agendamento conforme o desenho final do catálogo de
navegação. A configuração é por vínculo em `user_organizations.interface_settings`,
não em `organizations.interface_settings`.

O passo global `connect-whatsapp` não será removido nem reescrito para o CRM
inteiro nesta fatia. No fluxo AtendePro, o caminho principal é o existente
`skipWhatsapp()`/"configurar depois"; nenhum QR ou número real é iniciado. O
bootstrap do simulador deve existir antes de publicar a versão do agente, para
que pular WhatsApp não deixe o agente sem um canal operacional de teste.

## 2. Gatilho de implementação da primeira fatia

A ordem de trabalho é:

1. migration e tipos do canal `simulator`, incluindo constraints e exclusões do
   watchdog;
2. adapter/runtime determinístico sem rede, com fixture de agente e fallback
   de RAG sem chave externa;
3. rota autenticada multirrodada que resolve a organização pela sessão,
   reaproveita/insere contato de teste idempotentemente e grava mensagens;
4. execução autorizada das tools canônicas de lead e agenda, com auditoria;
5. onboarding/preset AtendePro e fachada de configuração;
6. testes unitários, invariantes/RLS, zero-egress e E2E da jornada completa.

Nenhuma rota aceita `organization_id` do body/query. Toda escrita com client de
admin filtra a organização explicitamente e exige idempotência. O contacto de
teste deve ser identificável por metadata/tag reservada, sem usar dados de
clientes reais.

## 3. Gates antes de chamar a fatia de pronta

- toolchain Node 22 + pnpm 9 resolvida;
- typecheck, lint e `lint:channels` verdes;
- preview antigo continua sem efeitos;
- simulador prova zero chamadas de saída e zero acesso a clientes de produção;
- tenant A não lê nem altera dados do tenant B;
- ações de lead/agendamento aparecem em `api_audit_log` e nas timelines corretas;
- repetição da mesma operação não cria contatos, cards, mensagens ou horários
  duplicados;
- E2E reproduzível: onboarding → configuração → conversa → ação CRM.

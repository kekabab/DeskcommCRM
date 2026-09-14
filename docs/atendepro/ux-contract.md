# AtendePro — Contrato de UX e Frontend (Primeira Fatia Vertical)

> Precedência: `contract-cross-review.md` define o vocabulário canônico do backend e os hrefs reais; a UX não cria preset ou entidade paralela.

- **Papel Responsável:** Boreal (UX e Frontend Simplificado)
- **Data:** 2026-09-13
- **Baseline de Código:** `DeskcommCRM-canonical` (`ca2eb0a`)
- **Documentos de Referência:** `docs/atendepro/project-brief.md`, `project-state.md`, `decisions.md`, `blockers.md`
- **Status do Contrato:** Proposta formal para alinhamento com Cometa (CRM), Duna (IA/Simulação), Eclipse (QA/E2E), Aurora (Arquitetura) e Fenix (Segurança).

---

## 1. Princípios de Experiência e Fronteiras de Abstração

1. **Camada, Não Segundo CRM (D-001):** Toda tela da camada AtendePro consome e alimenta as tabelas e rotas canônicas do DeskcommCRM (`organizations`, `contacts`, `crm_leads`, `calendar_appointments`, `mcp_agents`). Nenhuma tabela paralela será criada.
2. **Esconder a Infraestrutura Técnica (Briefing § Princípio 2):** RAG, embeddings, vetores, workers BullMQ, prompts brutos do sistema, JSONs de tool calls MCP, limites de tokens (`token_budget`), chaves de API e banco de dados ficam **100% invisíveis** para o usuário final.
3. **White-Label e Marca Configurável (D-002):** O nome "AtendePro" e sua identidade visual residem exclusivamente na camada de configuração e branding (`settings.branding`), preservando flexibilidade para revenda e personalização por tenant.
4. **Local Antes de WhatsApp (D-004):** A primeira validação ponta a ponta acontece inteiramente em ambiente local e modo simulado. Canais reais (WAHA / Meta Oficial) só entram após validação completa da jornada.

---

## 2. Jornada da Primeira Fatia Vertical (Passo a Passo)

A primeira fatia vertical do AtendePro cobre o ciclo completo de ativação e valor:
```
[1. Onboarding Negócio & Serviço] 
               ↓
[2. Ativação do Atendente & Horários] 
               ↓
[3. Conversa Simulada (Sandbox no Inbox)] 
               ↓
[4. Agendamento & Movimentação no CRM (Auditados)]
```

---

### Etapa 1 — Onboarding Unificado (Negócio, Serviços e Atendente)

#### 1.1 Objetivo de UX
Eliminar o atrito do onboarding atual (que hoje força escaneamento de QR Code de WhatsApp no passo 2 e expõe configurações de IA com termos de desenvolvedor). Reunir em uma experiência guiada, clara e acolhedora:

1. **Identidade do Negócio:**
   - Nome fantasia da empresa (`display_name`).
   - Nicho/Segmento (ex.: Salão/Barbearia, Clínica/Consultório, Serviços Gerais, Consultoria).
   - Fuso horário de atendimento (`timezone`).
2. **Catálogo de Serviços Agendáveis:**
   - Nome do serviço (ex.: "Corte e Barba", "Consulta Avaliativa").
   - Duração (em minutos: 15, 30, 45, 60, 90).
   - Preço sugerido / valor em R$ (ex.: R$ 80,00).
   - Modalidade (Presencial no local ou Online).
3. **Janela de Atendimento e Horários:**
   - Dias da semana em que atende (Segunda a Sábado, etc.).
   - Horário de início e término (ex.: 08:00 às 18:00) e intervalo de almoço.
4. **Personalidade e Regras da Casa do Atendente:**
   - Nome do atendente virtual (ex.: "Bia da Clínica Sorriso").
   - Tom de voz (seletor amigável de cartões):
     - *Próximo e caloroso* (empático, acolhedor, ideal para estética e varejo).
     - *Objetivo e cordial* (direto, focado em agendamento, ideal para clínicas).
     - *Curto e prático* (respostas pontuais, transição rápida para atendente humano).
   - Regras da Casa (campo de texto livre com exemplos reais de pequenos negócios):
     - *"Nunca passe orçamento de procedimentos cirúrgicos."*
     - *"Se o cliente perguntar de convênio, informe que emitimos recibo para reembolso."*
     - *"Tolerância máxima de atraso de 15 minutos."*

#### 1.2 Telas e Rotas Propostas
- Rota no Onboarding: `/onboarding/atendepro` (ou refatoração modular de `/onboarding/welcome` + `/onboarding/setup-ai` + `/onboarding/servicos`).
- **Garantia de Navegação:** Uso estrito de transições SPA (`useRouter` e Server Actions), eliminando qualquer recarregamento forçado via `window.location.href`.

---

### Etapa 2 — Disponibilidade e Agendamento

#### 2.1 Visualização e Regras
- **Gestão Simplificada de Serviços:** Unificada sob a interface do AtendePro em `/app/settings/atendepro/servicos` (conectada por baixo a `calendar_event_types` e `crm_products`).
- **Grade da Agenda ([`app/app/agenda`](file:///mnt/c/teste/DeskcommCRM-canonical/app/app/agenda/page.tsx)):**
  - Exibição de slots ocupados e disponíveis em blocos visuais claros.
  - Sincronização externa (Google Calendar) tratada com privacidade: exibe apenas "Ocupado" sem vazar títulos privados de compromissos pessoais dos profissionais.
- **Handoff Humano Automático:**
  - Se o cliente expressar frustração, solicitar humano explicitamente ("quero falar com atendente") ou perguntar algo fora das regras da casa:
    - O atendente virtual encerra educadamente o turno de IA.
    - Notifica o operador humano.
    - A conversa é transferida para a aba **Fila** no Inbox com badge visual destacado.

---

### Etapa 3 — Conversa Simulada (Modo Sandbox no Inbox)

#### 3.1 Requisito Arquitetural e de UX (D-004)
O operador precisa testar o comportamento do atendente **antes** de colocar clientes reais em contato. O teste não pode ser um disparo único com JSON de backend (como no `TestPanel.tsx` atual), mas uma **sessão de chat interativa e contínua**.

#### 3.2 Comportamento da Interface
1. **Entrada pelo Inbox:**
   - Botão de ação rápida no topo do Inbox: **"Iniciar Conversa Simulada"**.
   - Abre uma conversa especial demarcada visualmente com tarja/borda de segurança: `[MODO SIMULADO — NENHUMA MENSAGEM EXTERNA SERÁ ENVIADA]`.
2. **Experiência de Teste:**
   - O operador escreve na posição do cliente: *"Olá, queria agendar uma consulta para amanhã à tarde."*
   - O atendente virtual responde consultando a disponibilidade real do sistema: *"Olá! Temos horários disponíveis amanhã às 14h e às 16h30. Qual fica melhor para você?"*
   - O operador confirma: *"Às 14h, por favor. Meu nome é Carlos."*
   - O motor executa os tool calls internamente nos bastidores (`crm_create_lead`, `calendar_create_appointment`).
   - O atendente responde: *"Confirmado, Carlos! Agendado para amanhã, às 14h. Te esperamos!"*
3. **Painel Lateral Contextual:**
   - Ao lado da conversa simulada, o painel exibe em tempo real:
     - Lead criado no CRM.
     - Horário bloqueado na Agenda.
     - Regra ou serviço consultado.

---

### Etapa 4 — Resultado Auditado no CRM

Após a conclusão da conversa simulada ou real, o operador confere os impactos em cascata no sistema:

1. **No Inbox ([`app/app/inbox`](file:///mnt/c/teste/DeskcommCRM-canonical/app/app/inbox/page.tsx)):**
   - Histórico completo da conversa preservado.
   - Status da conversa: movida para "Automático" ou "Minhas/Fechadas".
2. **No Funil / Kanban ([`app/app/kanban`](file:///mnt/c/teste/DeskcommCRM-canonical/app/app/kanban/page.tsx)):**
   - O lead surge no funil padrão ("Pedidos" ou "Atendimentos") na coluna correspondente (ex.: `Agendado`).
   - Card do lead com valor do serviço selecionado e responsável atribuído.
3. **Na Agenda ([`app/app/agenda`](file:///mnt/c/teste/DeskcommCRM-canonical/app/app/agenda/page.tsx)):**
   - Evento criado e posicionado no dia e hora combinados, com o nome do cliente e tipo de serviço.
4. **No Audit Log ([`app/app/audit`](file:///mnt/c/teste/DeskcommCRM-canonical/app/app/audit/page.tsx)):**
   - Registro de auditoria imutável: `tipo: appointment_created`, `ator: Atendente IA (Simulação)`, `origem: sandbox`.

---

## 3. Estados de Erro e Degradação Graciosa

A interface do AtendePro nunca deve expor erros de stack trace, HTTP 500 ou códigos crus (ex.: `131047`, `MISCONF`, `RLS violation`).

| Cenário de Falha | Mensagem Técnica Interna | Apresentação em Linguagem de Negócio (AtendePro) | Ação de Recuperação Oferecida |
| :--- | :--- | :--- | :--- |
| **Provedor de IA sem chave/saldo** | `LLM provider 401/429 / quota exceeded` | *"O atendente virtual está em pausa aguardando conexão com a inteligência."* | Botão para validar conexão no painel de configurações ou continuar com atendimento humano manual. |
| **Janela de 24h WhatsApp expirada** | `Meta graph 131047` | *"A janela de conversa livre deste cliente encerrou (limite de 24h do WhatsApp)."* | Sugere envio de modelo de mensagem pré-aprovado (HSM) ou aguardar contato do cliente. |
| **Conflito de Horário na Agenda** | `calendar_slot_collision` | *"Este horário acabou de ser ocupado. Que tal oferecer um destes horários livres?"* | Exibe lista rápida de 3 próximos horários livres calculados pelo motor de disponibilidade. |
| **Falha de Conexão em Tempo Real** | `supabase realtime disconnect` | Indicador sutil e não intrusivo com re-conexão automática em background. | Botão "Recarregar conversas" sem perda de rascunhos no composer. |

---

## 4. Requisitos Mobile e Acessibilidade (a11y)

1. **Responsividade Estrita (Viewport Mobile):**
   - Em telas `< 768px`, o Inbox exibe alternância estrita entre lista de conversas e conversa ativa ([`colunasDoCelular`](file:///mnt/c/teste/DeskcommCRM-canonical/components/inbox/InboxLayout.tsx#L55-L60)), garantindo que o teclado virtual não cubra o campo de mensagem (`h-[100dvh]`).
   - Alvos de toque (touch targets) com altura mínima de 44px (`h-11` do design system nos botões mobile).
2. **Correção do Bug Estrutural Radix em `InboxFilters.tsx`:**
   - **Problema atual:** `<Tabs>` e `<TabsTrigger>` geram `aria-controls` para painéis inexistentes (`TabsContent`), violando `aria-valid-attr-value` no axe-core.
   - **Contrato de Correção:** Substituir as abas cosméticas por botões de filtro semânticos com `role="tab"` e `aria-selected` devidamente vinculados ou fornecer os `TabsContent` correspondentes, eliminando a exceção manual no teste [`tests/e2e/rbac-roles.spec.ts`](file:///mnt/c/teste/DeskcommCRM-canonical/tests/e2e/rbac-roles.spec.ts).
3. **Suporte a Leitores de Tela:**
   - Mensagens recebidas no chat devem acionar região `aria-live="polite"` para anúncio imediato.
   - Contraste visual de todos os elementos de texto com índice mínimo de 4.5:1 (WCAG AA), assegurado pelos tokens do Sage Design System.

---

## 5. Mapeamento de Destinos de Navegação (Novo Preset `atendepro`)

Para sanar a falha em que o preset `"simplificada"` atual oculta todas as configurações essenciais do pequeno negócio, define-se a projeção de navegação para a camada AtendePro:

### Destinos Visíveis no Sidebar do AtendePro:
1. **Inbox** (`/app/inbox`) — Atendimentos reais e conversas simuladas.
2. **Agenda** (`/app/agenda`) — Compromissos e grade da semana.
3. **Funil** (`/app/kanban`) — Quadro de clientes e etapas de venda/serviço.
4. **Contatos** (`/app/contacts`) — Histórico e ficha dos clientes.
5. **Meu Negócio & Atendente** (`/app/settings/atendepro`) — Fachada unificada de configuração:
   - Dados comerciais e Marca (nome, logo, cor).
   - Personalidade e Regras do Atendente Virtual.
   - Serviços, Preços e Horários de Atendimento.
6. **Configurações Básicas** (Rodapé fixo):
   - Meu Perfil (`/app/settings/profile`)
   - Segurança / Senha (`/app/settings/security`)
   - Minha Equipe (`/app/team`)

*Todas as 13 telas do hub técnico de IA (`/app/ai/*`), roteadores complexos e webhooks ficam protegidas na área técnica/supervisão (restrita a administradores avançados da instalação).*

---

## 6. Cruzamento Multidisciplinar e Mapeamento de Lacunas

### 6.1 Cometa (CRM, Onboarding e Fluxos Operacionais)
- **Interseção:** O Onboarding AtendePro deve persistir contatos, leads e agendamentos nas entidades existentes sem desvios de integridade.
- **Lacunas Identificadas (Gaps):**
  - **[GAP-COM-01] Preço em Serviços de Agendamento:** A tabela `calendar_event_types` possui categoria e duração, mas **não possui coluna de preço** (`price_cents`). Hoje preços residem em `crm_products`. Cometa precisa definir se serviços agendáveis criam automaticamente uma linha correspondente em `crm_products` ou se `calendar_event_types` receberá um campo de valor referencial via migração segura.
  - **[GAP-COM-02] Gatilho de Etapa do Funil:** Quando a IA conclui um agendamento na conversa simulada, é necessário garantir que o lead seja movido deterministicamente para a etapa "Agendado" no funil padrão.

### 6.2 Duna (Agentes Nativos, RAG, MCP e Simulação)
- **Interseção:** A conversa simulada necessita interagir com o runtime do agente nativo executando tool calls canônicos (`crm_create_lead`, `calendar_create_appointment`, `search_knowledge`).
- **Lacunas Identificadas (Gaps):**
  - **[GAP-DUN-01] Endpoint de Simulação Multirrodada:** O endpoint existente (`/api/v1/ai/agents/:id/versions/:vid/test`) opera apenas no formato pergunta-resposta isolada (dry-run de 1 turno) e descarta o estado. Duna precisa especificar uma rota de sessão simulada (`/api/v1/ai/simulation/session`) que mantenha histórico de mensagens e simule o dispatcher sem tocar no provedor de WhatsApp real.
  - **[GAP-DUN-02] Modo de Resposta Sem Provedor Externo (Mock/Stub):** Para atender a ambientes locais sem saldo em OpenAI/Anthropic (Blocker B-003), o motor de simulação precisa suportar um provedor de stub determinístico capaz de executar a máquina de estados de agendamento.

### 6.3 Eclipse (QA, E2E e Performance)
- **Interseção:** A validação da primeira fatia vertical requer testes reproduzíveis com evidência antes de qualquer liberação de código.
- **Lacunas Identificadas (Gaps):**
  - **[GAP-ECL-01] Fixture de E2E para o Modo Simulado:** Os testes Playwright atuais dependem de instâncias pré-configuradas com autenticação pesada e WhatsApp. Eclipse precisa desenhar uma spec E2E limpa (`tests/e2e/atendepro-fatia-vertical.spec.ts`) que cubra: *criação de serviço → conversa simulada → confirmação na agenda → verificação no funil*.
  - **[GAP-ECL-02] Medição de Acessibilidade no Inbox:** Substituir a exclusão `[role="tablist"]` no teste de acessibilidade pelo teste automatizado com zero violações no componente refatorado.

---

## 7. Próximos Passos Imediatos da Equipe

1. **Submissão do Contrato:** Apresentar este documento `docs/atendepro/ux-contract.md` para revisão dos papéis Cometa, Duna, Eclipse, Aurora e Fenix.
2. **Fechamento de Lacunas:** Cometa e Duna resolvem os gaps [GAP-COM-01] e [GAP-DUN-01] nos respectivos contratos de CRM e Runtime.
3. **Início da Implementação:** Somente após o fechamento formal de todos os contratos e alinhamento do toolchain local (Node 22 / pnpm 9).

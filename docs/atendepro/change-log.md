# AtendePro — Changelog de coordenação

## 2026-09-13

### Fatia AtendePro / Simulator

- Contratos cruzados entre Aurora, Boreal, Cometa, Duna, Eclipse e Fenix consolidados em `contract-cross-review.md`.
- Onboarding idempotente grava o preset `simplificada` na membership ativa e direciona para a Inbox.
- Canal local persistente adicionado com provider `simulator`, chave deterministica por organizacao e constraints/indexes anti-corrida.
- Runtime do simulador grava contato, conversa, mensagens inbound/outbound, `ai_agent_runs` e auditoria sem WhatsApp, WAHA, Meta, Zernio ou LLM externo.
- UI de onboarding e Inbox ganhou entrada para simulacao multirrodada; o preview dry-run permanece separado.
- Revisao de seguranca corrigida: corrida de sessao tratada e erros de banco mascarados na resposta publica.
- Validacao automatizada executada em stack Supabase isolada, com Corepack, sem conectar providers externos.
- `pnpm typecheck`, lint focado, `lint:channels`, `lint:role-rank` e Prettier passaram.
- Sete arquivos de testes focados passaram (33 testes); o wizard E2E passou em 13 cenarios e o fluxo vertical dedicado passou em 1/1.
- Smoke E2E do CRM passou em 11/11: conversa vira lead, ações em lote no funil, importação e agenda.
- Baseline INSTALL/UPDATE, update sobre dados existentes e migration 0239 idempotente passaram.
- O `test:unit` completo ainda tem falhas legadas fora da fatia AtendePro; isso permanece gate para o release final.

- Repositório oficial DeskcommCRM identificado e baixado localmente.
- Auditoria somente leitura distribuída aos seis agentes existentes.
- Conexões laterais reforçadas entre UX, CRM, IA, QA e segurança.
- Nota compartilhada `AtendePro-Maestro-State` criada; etiquetas do Portal Regional marcadas como histórico.
- Checkout canônico criado em `C:\teste\DeskcommCRM-canonical`.
- União das partes do pacote validada: 4.129 arquivos, zero faltantes, zero extras.
- Baseline Git local criada em `ca2eb0a`; nada publicado.
- Nenhum WhatsApp, WAHA, Meta, Zernio, Wacalls ou LLM externo foi conectado; os containers antigos foram preservados.

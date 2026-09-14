# AtendePro — Estado do projeto

## Registro

### Estado de implementacao atual — 2026-09-13

Este bloco supersede o retrato historico abaixo:

- A primeira fatia vertical esta implementada na arvore de trabalho: onboarding/preset, canal `simulator`, runtime persistente zero-egress, UI multirrodada e testes de rota.
- A migration `20260913160000_0239_canal_simulador_local.sql` e o contrato cruzado foram aplicados e validados no banco Supabase isolado.
- A fatia esta commitada localmente em `f70d1945` na branch `publish/atendepro-latest`; a publicacao no `main` remoto aguarda permissao de escrita no repositorio.
- A validacao operacional foi executada em stack Supabase isolada, com dependencias via Corepack e sem tocar nos containers antigos.
- O fluxo ponta a ponta onboarding -> simulador -> Inbox -> persistencia passou com zero egressos observados.
- O gate restante e de release: concluir a bateria geral de testes legados, configurar observabilidade/Redis de producao e validar provider real em staging controlado.

- Data: 2026-09-14
- Fase: fatia vertical implementada; validacao focada concluida; release controlado pendente
- Workspace canônico: `C:\teste\DeskcommCRM-canonical`
- Repositório de origem: `https://github.com/melgarafael/DeskcommCRM`
- Branch local: `publish/atendepro-latest`
- Baseline remoto reconciliado: `c890afce`

## Estado do ambiente

- Código canônico validado contra o ZIP oficial: 4.129 arquivos, sem ausências ou extras.
- Node 24.x foi usado no host via Corepack; a matriz de release ainda deve fixar Node 22 conforme documentacao do projeto.
- Docker disponivel; a validacao usou um projeto Supabase isolado com portas 55420-55424 e 55429.
- Baseline instalada e reaplicada; migration 0239 aplicada duas vezes com sucesso e sem duplicacao.
- O script update-com-dados passou preservando 10 linhas sem violar constraints.
- Nenhum WhatsApp, WAHA, Meta, Zernio, Wacalls ou LLM externo foi conectado.

## Evidencias de validacao — 2026-09-14

- `pnpm typecheck`: verde.
- `pnpm build`: verde; a rota `/api/v1/simulator/messages` foi incluida no build de producao.
- ESLint dos arquivos tocados e Prettier: verde; `lint:channels` e `lint:role-rank`: verdes.
- Testes focados de AtendePro e baseline: 7 arquivos, 33 testes verdes.
- Fluxo vertical dedicado onboarding -> simulador -> CRM: 1/1 verde novamente em porta isolada `3101`.
- Smoke E2E da home: 1/1 verde novamente em porta isolada `3102`.
- Smoke E2E do CRM: conversa -> lead, lote no funil, importacao e agenda: 11/11 verdes.
- Banco: INSTALL/UPDATE da baseline e UPDATE sobre dados existentes verdes; migration 0239 idempotente.
- O script `test:atendepro` foi adicionado para reproduzir o gate focado sem depender do ambiente jsdom global.
- O `test:unit` completo ainda encontrou falhas preexistentes em suites de importacao, i18n, fixtures, release e cobertura E2E; elas nao bloquearam os gates especificos desta fatia e devem ser tratadas antes do release final.

## Estado da equipe

Os seis agentes existentes permanecem conectados. A nota `AtendePro-Maestro-State` é a referência compartilhada. As conexões laterais foram reforçadas entre arquitetura, UX, CRM, IA, QA e segurança.

## Posse de arquivos

Nenhum arquivo de código está em posse de agente nesta fase. As auditorias foram somente leitura. A posse será registrada antes de cada alteração.

## Evidências já obtidas

- o DeskcommCRM já possui base de multi-tenancy, RLS, RBAC, auditoria, CRM, agenda, follow-up, agentes, RAG, MCP e testes;
- a camada AtendePro precisa principalmente de simplificação de experiência, onboarding, presets e modo simulado;
- a documentação `docs/current-state.md` é um retrato datado e não será tratada como estado atual sem medição local;
- o checkout `DeskcommCRM-local` anterior ficou particionado e foi preservado; o trabalho seguirá no checkout canônico novo.

## Próximas passagens históricas

1. fechar contratos de arquitetura, UX, onboarding, agentes, QA e segurança;
2. resolver toolchain local sem tocar em produção;
3. definir e implementar uma única fatia vertical: onboarding → configuração → conversa simulada → ação auditada no CRM;
4. revisar com QA e Segurança antes de ampliar.

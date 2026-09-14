# AtendePro — Bloqueios e riscos de partida

## B-001 — Toolchain local

O host tem Node 24.x, enquanto o projeto documenta Node 22, e não possui pnpm. Antes dos testes reais, escolher uma instalação local compatível de Node 22 e pnpm 9, sem alterar produção.

## B-002 — Serviços locais desligados

Docker está disponível, mas os serviços do DeskcommCRM estão parados. O Maestro deverá identificar o compose e iniciar somente a instância necessária, registrando portas e logs.

## B-003 — Provedor de IA

O fluxo de simulação deve funcionar com mock/dry-run. Uma resposta de modelo real exigirá um provedor autorizado e configuração local; as seis sessões Maestri não são automaticamente um endpoint de runtime.

## B-004 — WhatsApp

WAHA ou canal oficial só entra depois de autorização explícita, número dedicado de teste, limites, logs e prova de que mensagens não serão enviadas acidentalmente.

## B-005 — Estado documental

`docs/current-state.md` é um retrato datado. Toda afirmação operacional deverá ser conferida no código e por execução local.

## B-006 — Segurança antes de escrita autônoma

A auditoria apontou pontos que exigem validação antes de liberar agentes internos com escrita: handlers com service role, rate limit degradado sem Redis e permissões de audit log. Não liberar automação irrestrita enquanto Fenix não aprovar.

## B-007 — Checkout anterior preservado

As árvores `DeskcommCRM-local`, `DeskcommCRM-local-backup-incompleto` e `DeskcommCRM-archive` permanecem fora do fluxo principal para manter reversibilidade. Nenhuma será apagada nesta fase.


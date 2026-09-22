# HANDOFF — Radar de Oportunidades (Spec 19)

> Leia este arquivo no início de qualquer sessão que continue o Radar. Atualizado em
> 2026-09-22. Estado aqui é da branch, não da instalação em produção.

## Estado em uma frase

O módulo foi implementado e enviado ao fork na branch
`feat/opportunity-intelligence` (commit inicial `5ae49f18`), mas **ainda não foi
integrado à `main`, lançado nem ativado em produção**. A descoberta tem uma
fronteira humana: não envia mensagens automaticamente. Nenhuma fonte externa real
fica habilitada por padrão.

## O que já existe

- **Domínio e pipeline:** `lib/opportunity-intelligence/` contém regras de
  identidade/deduplicação, evidência, avaliação, fontes, quotas, leitura/escrita
  e orquestração do worker. A evidência tem origem e frescor; a decisão é
  explicável e a fronteira exige aprovação humana.
- **Persistência:** migrations `0240`–`0245` definem oportunidades, evidências,
  ações, resultados, fontes/varreduras, idempotência, fronteira de mutação,
  escrita transacional e quota por tenant. A tripla de distribuição está em
  `supabase/migrations/`, `supabase/baseline.sql` e
  `supabase/migrations/MANIFEST.md`.
- **API e cron:** rotas em `app/api/v1/opportunity-intelligence/` e
  `app/api/v1/cron/opportunity-discovery/`; o scheduler solicita a varredura a
  cada 15 minutos. O intake/worker é reprocessável e não faz envio outbound.
- **CRM e interface:** `/app/opportunities` oferece Radar, dossiê, fila de
  exceções, configuração de fontes e indicador de quota. A navegação está em
  `lib/navigation/catalogo.ts`; o vínculo com negócio existente registra
  `opportunity_linked` na timeline.
- **Contrato e testes:** contrato técnico em
  `docs/specs/19-spec-opportunity-intelligence.md`; testes unitários,
  de rotas, worker e Playwright nos caminhos de feature.

O primeiro vertical descrito na spec são empresas prestadoras de serviços
digitais para negócios locais. Não amplie para outros nichos antes de medir
precisão nesse fluxo.

## O que foi validado até aqui

As seguintes verificações foram executadas no trabalho da branch:

- TypeScript estrito, ESLint focado e build de produção: passaram.
- Vitest focado: **145 testes em 22 arquivos passaram**, usando ambiente Node
  por uma limitação de permissão do jsdom no Windows. Isso **não equivale** à
  suíte completa `pnpm test:unit`.
- Playwright da feature: **6/6** passaram.
- Smoke de banco: ACLs principais e concorrência da quota atômica passaram
  (uma requisição admitida e a concorrente recusada).
- `corepack pnpm run release:conferir`: passou; calculou `1.22.0 + minor`.
  Isso é apenas cálculo do fragmento, **não** uma release criada/publicada.

Ainda não trate estes resultados como prova completa para merge ou operação:
não foi registrado aqui um `pnpm test:db` completo em Postgres 15 fresco
(baseline em install e reaplicação/update), a suíte unitária completa, os checks
do CI da branch ou a jornada visual completa de instalação fresca com evidência
para o mapa de jornadas.

## Próximos passos — nesta ordem

1. **Atualizar a própria Spec 19.** Ela ainda chama partes já implementadas de
   “futuras” e tem uma seção “Integração planejada”. Conferir cada afirmação
   contra o código e registrar o estado real sem prometer coleta que ainda não
   existe.
2. **Registrar o mapa vivo:** criar
   `docs/architecture/opportunity-intelligence.architecture.json` com pelo
   menos duas arestas concretas (fonte autorizada → adapter/validação → writer
   transacional → Radar/CRM; outcome → ciclo de decisão) e acrescentar a entrada
   no catálogo `docs/architecture/README.md`.
3. **Conectar a spec Playwright ao CI.** Hoje
   `tests/e2e/opportunity-intelligence.spec.ts` não aparece em
   `.github/workflows/e2e.yml`. Incluí-la em `SPECS_PARTE_N` ou, se houver
   motivo real, em `FORA_DO_CI` com justificativa; conferir
   `tests/unit/e2e-cobertura-completa.test.ts`.
4. **Completar a prova de jornada:** atualizar
   `docs/testing/user-journey-map.md` com o fluxo, os casos de revisão humana e
   os limites; verificar/produzir a evidência visual pelo frontend, em banco
   fresco baseado no baseline.
5. **Rodar os gates completos antes de PR:** `pnpm typecheck`, `pnpm lint`,
   `pnpm lint:channels`, `pnpm test:unit` sem recorte, `pnpm test:db`
   (Docker/Postgres 15, baseline install + update), `pnpm build` e o E2E
   aplicável. Comparar o resumo de testes com os arquivos que falharam; não
   reportar apenas o recorte verde.
6. **Só então preparar PR** do fork
   `kekabab/DeskcommCRM:feat/opportunity-intelligence` para
   `melgarafael/DeskcommCRM:main`, informar o que não foi medido e acompanhar
   os checks obrigatórios. Não fazer merge nem deploy sem autorização do dono.
7. **Antes de ativar descoberta real:** selecionar e autorizar uma fonte
   específica; revisar termos/permissões, domínios permitidos, região, limite de
   requisição, quota, retenção e dados pessoais/LGPD. Fazer piloto com dados
   sintéticos e aprovação humana. Fonte real continua desligada até esse
   trabalho; não contornar isso com scraping genérico ou envio automático.

## Guardrails que não devem ser removidos

- Não duplicar `crm_leads`; vincular ao negócio existente ou pedir revisão
  quando identidade/associação for ambígua.
- Evidência vencida, contraditória, fraca ou de origem não autorizada não pode
  sustentar uma ação.
- `require_human_approval: true` e a ausência de outbound automático são
  fronteiras deliberadas, não placeholders para ligar sem revisão.
- Toda mudança de schema precisa de migration nova + apêndice idempotente no
  baseline + MANIFEST; depois de uma migration aplicada, corrigir por
  forward-fix, nunca editando-a.
- `origin` é o fork do usuário; `upstream` é o repositório original. Continuar
  nesta branch, sem force-push, reset destrutivo ou push direto à `main`.

## Retomada rápida

Leia `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, este handoff e a Spec 19.
Depois confira `git status --short --branch` e atualize `origin`; o último
commit conhecido é `5ae49f18`. Se uma validação for repetida, registre comando,
resultado e limitações neste handoff e no documento de autoridade correspondente.

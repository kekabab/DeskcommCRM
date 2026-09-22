# Spec 19 — Opportunity Intelligence

## Propósito

Adicionar ao DeskcommCRM uma camada de descoberta e decisão comercial que encontra oportunidades comprovadas, prepara a próxima ação e aprende com o resultado. O módulo não substitui `crm_leads`; ele se relaciona a um lead existente ou aguarda vinculação humana quando a identidade for ambígua.

## Primeiro vertical

O primeiro vertical é deliberadamente estreito: empresas que vendem serviços digitais para negócios locais. O motor interno será adaptável, mas o produto só amplia para outros nichos depois de provar precisão com um fluxo fechado.

## Contrato de domínio

- `signal`: indício observável, como demanda pública recente ou caminho de conversão ausente.
- `evidence`: afirmação rastreável com fonte, URL, data de coleta, frescor e confiança.
- `opportunity`: hipótese comercial explicável que agrupa sinais e evidências para uma identidade.
- `recommended_action`: próxima ação proposta pelo sistema, nunca uma mensagem livre sem lastro.
- `exception`: motivo determinístico para parar, renovar evidência, vincular lead ou pedir humano.
- `outcome`: resposta que realimenta o scoring e o próximo experimento.

O primeiro corte vive em `lib/opportunity-intelligence/domain.ts` e é puro. Persistência, workers e UI só entram quando esse contrato for revisado pelos agentes e coberto por testes.

Adaptadores de descoberta seguem o contrato em `lib/opportunity-intelligence/sources.ts`. Cada adaptador precisa declarar sua política, URL de termos, limite de requisição e regiões suportadas. Um candidato que não pertence ao adaptador ou que vem de uma fonte sem autorização explícita é rejeitado antes de entrar no pipeline. A deduplicação é por identidade canônica, não por nome exibido.

`lib/opportunity-intelligence/discovery.ts` executa `collect → validate → dedupe` sem efeitos colaterais. Falha de uma fonte vira erro explícito da rodada e não apaga candidatos válidos de outra fonte. O worker futuro deve persistir o resultado e emitir os eventos canônicos, mas não colocar HTTP dentro de trigger de banco.

O orquestrador de uma rodada vive em `lib/opportunity-intelligence/worker.ts`. Ele isola erros de avaliação por candidato, rejeita evidência de fonte que não participou da descoberta e força `require_human_approval: true` na fronteira do worker. A descoberta continua pura e injetável; a fronteira de persistência agora é uma RPC PostgreSQL transacional, sem acoplar coleta a banco.

O MVP atual não finge ter coleta externa ativa: `/intake` é a entrada controlada para um adapter autorizado, e o worker é a costura reprocessável entre adapter, avaliação, pipeline e writer. A próxima etapa de produção é cadastrar um adapter real com termos/rate limit, agendamento e telemetria de fonte antes de ligar qualquer coleta automática.

O dataset de prova em `lib/opportunity-intelligence/golden-fixtures.ts` cobre cinco casos: oportunidade forte, evidência contraditória, lead ativo já existente, destinatário suprimido e evidência fraca. Ele é a régua mínima para qualquer worker ou tela futura.

## Persistência do primeiro corte

A migration `0240_opportunity_intelligence` cria quatro tabelas tenant-aware:

- `opportunity_records`: identidade canônica, estado, confiança, sinais e vínculo opcional com `crm_leads`;
- `opportunity_evidence`: fonte, termos, política, claim, sinais, coleta e `expires_at` derivado;
- `opportunity_actions`: propostas internas idempotentes, com dor/oferta/prova e gate de aprovação;
- `opportunity_outcomes`: outcomes idempotentes que alimentam o ciclo de aprendizado.

Os filhos usam FK composta `(organization_id, opportunity_id)` para impedir mistura de tenants. O vínculo com um lead existente é validado por trigger contra a organização do lead. `suppressed` é terminal no banco, e só há uma ação `proposed`/`approved` aberta por oportunidade. A migration `0244_opportunity_pipeline_rpc` grava o lote inteiro (`record`, evidências, ação proposta, `event_log` e auditoria) em uma única transação, com unique funcional para eventos e retry seguro. A RPC é exclusiva do `service_role`; a fronteira server-side resolve o tenant e o actor. A tabela não dispara HTTP nem envia outbound.

As migrations `0241` a `0243` completam o corte operacional: fontes configuráveis exigem manifest/termos/rate limit e passam por anti-SSRF; o cron interno usa lock por organização/fonte/janela; mutações dos quatro agregados ficam fora do PostgREST para usuários autenticados; e a atividade `opportunity_linked` na timeline tem idempotência por tenant. Nenhuma fonte real é ativada por padrão e o modo Copiloto bloqueia envio autônomo.

Os eventos aceitos pelo `event_log` são exatamente `opportunity.signal_detected`, `opportunity.ready_for_action`, `opportunity.exception_raised` e `opportunity.outcome_recorded`.

## Regras de decisão v1

1. Sem evidência fresca e permitida, não existe ação autônoma.
2. Evidência contraditória sempre vai para revisão humana.
3. Lead ativo ou identidade ambígua nunca cria duplicata; a ação é vincular/revisar.
4. Destinatário suprimido é bloqueado antes de qualquer ação.
5. Confiança abaixo de 0,55 pede humano; entre 0,55 e 0,74 coleta mais evidência; a partir de 0,75 prepara rascunho personalizado.
6. “Preparar rascunho” não é “enviar”. Política de permissão e anti-spam governam qualquer envio posterior.
7. A pontuação é determinística e explicável; LLM pode propor sinais, mas não pode validar sua própria afirmação.
8. Uma oportunidade forte ainda precisa carregar dor, oferta e prova de valor; sem essa estratégia ancorada em evidência, o pipeline continua validando.
9. O resultado (`reply`, `meeting`, `deal_won`, `deal_lost`, `unsubscribed`, `ignored`) fecha o ciclo e altera o estado de forma determinística.

## Integração planejada

O módulo reutilizará `crm_leads`, `crm_lead_activities`, conversas, `event_log`, workers, handoff, avisos e MCP. Toda persistência futura será tenant-aware, idempotente, auditada e acompanhada de migration, baseline, manifest, RLS e testes de isolamento.

## Critério de aceite do primeiro marco

Com dados fictícios, o domínio deve:

- deduplicar identidades e idempotência por tenant/fonte;
- aceitar apenas evidências válidas e frescas;
- preparar ação quando os sinais obrigatórios estiverem comprovados;
- parar diante de contradição, opt-out, baixa confiança ou lead ativo;
- devolver uma decisão reprocessável sem efeitos duplicados.

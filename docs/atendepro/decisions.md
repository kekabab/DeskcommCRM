# AtendePro — Decisões

## D-001 — Reutilizar o DeskcommCRM

O DeskcommCRM permanece como motor operacional. Não serão duplicados contatos, conversas, leads, funis, agentes, memória, RAG, workers ou filas.

## D-002 — AtendePro é white-label/configuração

O nome é provisório e deve ser facilmente alterável pela configuração de marca existente. Não espalhar o nome em regras de negócio ou código estrutural.

## D-003 — Checkout canônico separado

O trabalho usa `C:\teste\DeskcommCRM-canonical`, criado a partir da união não sobreposta das partes do pacote oficial. As cópias incompletas anteriores ficam preservadas e não são contratos.

## D-004 — Local antes de WhatsApp

O MVP começa sem WhatsApp real. O canal simulado deve provar o fluxo e impedir egressos. Um número de teste só será conectado depois de autorização explícita e validação local.

## D-005 — Agentes do produto e agentes Maestri são camadas diferentes

Os seis agentes Maestri governam desenvolvimento e operação técnica. Os agentes nativos do DeskcommCRM executam atendimento e ações do produto através das interfaces protegidas existentes.

## D-006 — Escrita controlada

Agentes internos começarão em leitura/aprovação. Qualquer escrita posterior passará pelas APIs/MCP canônicas, RLS, RBAC, escopo da organização, auditoria, idempotência e guardrails.

## D-007 — Etiquetas antigas arquivadas

Portal Regional e suas etiquetas não fazem parte deste projeto. Notas antigas são preservadas como histórico, mas não podem ser usadas como contrato, requisito ou fonte de decisão do AtendePro.


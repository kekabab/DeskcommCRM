# AtendePro — Briefing do projeto

## Status

Fase de descoberta e arquitetura. Desenvolvimento e validação exclusivamente locais.

## Objetivo

Transformar o DeskcommCRM em uma experiência simples para pequenos negócios que atendem clientes por conversa, mantendo o motor operacional, os agentes nativos, o CRM, a memória, o RAG, o MCP e as automações nos bastidores.

O AtendePro é uma camada de experiência e configuração. Não é um segundo CRM.

## MVP local

- organização e usuário administrador de teste;
- dados do negócio;
- serviços, preços, duração e disponibilidade;
- horários, intervalos e bloqueios;
- personalidade e regras do atendente;
- base de conhecimento;
- conversa simulada sem WhatsApp;
- contatos, leads, funil e movimentação auditável;
- agenda, follow-up e handoff humano;
- métricas básicas;
- pausar, ativar e acompanhar execuções do agente;
- área técnica protegida para supervisão.

## Fora do escopo desta fase

- VPS, deploy ou produção;
- contratação de serviços pagos;
- WhatsApp real sem autorização explícita;
- envio de mensagens reais;
- dados reais de clientes;
- remoção de bancos, volumes ou contêineres;
- reescrita ou duplicação do núcleo DeskcommCRM.

## Princípios

1. Reutilizar entidades, rotas, agentes e contratos existentes.
2. Esconder RAG, MCP, workers, filas, prompts, credenciais e banco da interface comum.
3. Usar configuração/white-label para o nome AtendePro.
4. Toda mutação deve respeitar organização, RBAC, RLS, auditoria e idempotência.
5. O simulador local vem antes de qualquer canal real.
6. Nenhuma conclusão de pronto sem teste reproduzível e evidência.

## Papéis do Maestri

- Aurora: arquitetura e integração do DeskcommCRM;
- Boreal: UX e frontend simplificado;
- Cometa: CRM, onboarding e fluxos operacionais;
- Duna: agentes nativos, RAG, MCP e simulação;
- Eclipse: QA, E2E e performance;
- Fenix: segurança, RLS, RBAC e operação.


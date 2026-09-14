-- Migration 0239 — Contrato de persistência para o simulador local AtendePro (zero-egress)
--
-- Adiciona suporte ao provider 'simulator' de forma estritamente isolada:
-- 1. Coluna explícita 'simulator_session_key' em 'channel_sessions'
-- 2. Atualização idempotente de 'channel_sessions_provider_check' para incluir 'simulator'
-- 3. Atualização idempotente de 'channel_sessions_provider_ref_check' exigindo 'simulator_session_key'
-- 4. Atualização idempotente de 'conversations_channel_check' aceitando 'simulator'
-- 5. Índice de unicidade de chave do simulador por organização

-- 1. Coluna explícita para a chave de sessão do simulador
alter table public.channel_sessions
  add column if not exists simulator_session_key text;

-- 2. channel_sessions.provider aceita 'simulator'
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_check
  check (provider = any (array['waha', 'meta_cloud', 'zernio', 'wacalls', 'simulator']));

-- 3. channel_sessions_provider_ref_check exige simulator_session_key quando provider='simulator'
alter table public.channel_sessions
  drop constraint if exists channel_sessions_provider_ref_check;
alter table public.channel_sessions
  add constraint channel_sessions_provider_ref_check
  check (
    ((provider = 'waha') and (waha_session_name is not null))
    or ((provider = 'meta_cloud') and (meta_phone_number_id is not null))
    or ((provider = 'zernio') and (zernio_account_id is not null))
    or ((provider = 'wacalls') and (wacalls_session_id is not null))
    or ((provider = 'simulator') and (simulator_session_key is not null))
  );

-- 4. conversations.channel aceita 'simulator'
alter table public.conversations
  drop constraint if exists conversations_channel_check;
alter table public.conversations
  add constraint conversations_channel_check
  check (channel in ('whatsapp', 'simulator'));

-- 5. Unicidade de sessão do simulador por organização
create unique index if not exists channel_sessions_simulator_key_unique
  on public.channel_sessions (organization_id, simulator_session_key)
  where (provider = 'simulator' and simulator_session_key is not null);

-- Uma conversa persistente por contato e sessão local. Isso torna o resolver
-- idempotente também sob duas mensagens iniciais concorrentes.
create unique index if not exists conversations_simulator_contact_session_unique
  on public.conversations (organization_id, contact_id, channel_session_id)
  where (channel = 'simulator');

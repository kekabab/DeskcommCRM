/**
 * A porta de entrada do seam. Feature nenhuma importa `lib/waha/*` direto —
 * pede o adapter do provider da conversa e o descritor de capabilities.
 */
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { wahaAdapter } from "./adapters/waha";
import { zernioAdapter } from "./adapters/zernio";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelProvider,
  OutboundEnvelope,
  RecipientInput,
} from "./types";

/**
 * Adapter do simulador local AtendePro (zero-egress).
 *
 * Nunca toca WAHA, rede externa ou WhatsApp real. Gera identificador sintético
 * local e opera isolado de qualquer provider externo.
 */
export const simulatorAdapter: ChannelAdapter = {
  provider: "simulator",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.phoneNumber) return input.phoneNumber.replace(/\D/g, "");
    if (input.waIdentity) return input.waIdentity;
    return "simulator:local";
  },

  isConfigured(): boolean {
    return true;
  },

  async send(_envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    // Zero-egress: gera id sintético local sem emitir tráfego externo
    const externalId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    return { externalId };
  },

  codes: {
    notConfigured: "simulator_not_configured",
    sendFailed: "simulator_send_failed",
    unknownError: "simulator_unknown_error",
  },

  echoExternalIds(input: { externalId: string; recipient: string }): string[] {
    return [input.externalId];
  },

  async checkHealth(): Promise<ChannelHealth> {
    return {
      reachable: true,
      status: "WORKING",
      detail: "Simulador local ativo (zero-egress)",
    };
  },
};

/**
 * Um adapter por provider que transporta mensagem.
 * wacalls não entra (voz apenas).
 */
const ADAPTERS: Partial<Record<ChannelProvider, ChannelAdapter>> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  zernio: zernioAdapter,
  simulator: simulatorAdapter,
};

/**
 * Fail-closed: provider sem adapter (ou fora da matriz) lança em vez de cair no
 * WAHA por default. Enviar pelo canal errado é pior que não enviar.
 */
export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`unknown_channel_provider: ${provider}`);
  return adapter;
}

export {
  capabilitiesOf,
  CHANNEL_CAPABILITIES,
  DEFAULT_CHANNEL_PROVIDER,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_SEM_MENSAGEM,
  canalConhecidoSemMensagem,
  transportaMensagem,
} from "./capabilities";
export { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "./session-ref";
export type { ChannelSessionRef } from "./session-ref";
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelProvider,
  ProviderDeMensagem,
  OutboundEnvelope,
  OutboundKind,
  OutboundMedia,
  RecipientInput,
} from "./types";

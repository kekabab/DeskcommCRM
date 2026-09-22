/**
 * Adaptador declarativo de auditoria de presença web para negócios locais.
 *
 * Em conformidade com a Spec 19 e os guardrails de Duna e Eclipse:
 * - Declara licença, termos de uso, rate limit e regiões suportadas.
 * - Coleta apenas dados públicos e fatos observáveis de presença digital.
 * - Falha de forma isolada sem efeitos colaterais no banco ou no CRM.
 */
import {
  sourceAdapterManifestSchema,
  type DiscoveryQuery,
  type SourceAdapter,
  type SourceAdapterManifest,
  type SourceCandidate,
} from "@/lib/opportunity-intelligence/sources";

export const WEB_PRESENCE_SOURCE_MANIFEST: SourceAdapterManifest = {
  source_id: "web-presence-audit",
  source_kind: "open_data",
  terms_url: "https://deskcomm.com/terms/open-data-audit",
  allow_automated_collection: true,
  rate_limit_per_minute: 60,
  supports_regions: [
    "BR",
    "SP",
    "RJ",
    "MG",
    "PR",
    "RS",
    "SC",
    "BA",
    "DF",
    "GLOBAL",
    "br",
    "sp",
    "rj",
    "mg",
    "pr",
    "rs",
    "sc",
    "ba",
    "df",
    "global",
    "br-sudeste",
    "br-sul",
    "br-nordeste",
    "br-norte",
    "br-centro-oeste",
  ],
};

export type WebPresenceBusinessRecord = {
  id: string;
  name: string;
  domain?: string;
  phone_e164?: string;
  city?: string;
  has_mobile_friendly_site: boolean;
  has_whatsapp_cta: boolean;
  ssl_valid: boolean;
  page_speed_score: number; // 0 a 100
};

export interface WebPresenceDataFetcher {
  fetchRecords(query: DiscoveryQuery): Promise<WebPresenceBusinessRecord[]>;
}

function sanitizeDomain(domain?: string): string | undefined {
  if (!domain) return undefined;
  const clean = domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return clean.length > 0 ? clean : undefined;
}

function sanitizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const clean = phone.trim().replace(/[\s()-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(clean) ? clean : undefined;
}

export function createWebPresenceAdapter(
  fetcher?: WebPresenceDataFetcher,
  manifestOverrides?: Partial<SourceAdapterManifest>,
): SourceAdapter {
  const manifest: SourceAdapterManifest = sourceAdapterManifestSchema.parse({
    ...WEB_PRESENCE_SOURCE_MANIFEST,
    ...manifestOverrides,
  });

  return {
    manifest,
    async discover(query: DiscoveryQuery): Promise<SourceCandidate[]> {
      const records = fetcher ? await fetcher.fetchRecords(query) : [];
      const now = new Date().toISOString();

      return records.map((record) => {
        const facts: Record<string, string> = {
          has_whatsapp_cta: String(record.has_whatsapp_cta),
          has_mobile_friendly_site: String(record.has_mobile_friendly_site),
          ssl_valid: String(record.ssl_valid),
          page_speed_score: String(record.page_speed_score),
        };

        if (!record.has_whatsapp_cta) {
          facts.missing_conversion_channel = "Site não possui botão de contato direto por WhatsApp";
        }
        if (!record.has_mobile_friendly_site) {
          facts.poor_mobile_experience =
            "Experiência mobile prejudicada ou sem viewport responsivo";
        }
        if (record.page_speed_score < 50) {
          facts.slow_loading_speed = `Velocidade lenta de carregamento (score ${record.page_speed_score}/100)`;
        }

        const domain = sanitizeDomain(record.domain);
        const sourceUrl = domain
          ? `https://${domain}`
          : `https://maps.local/${encodeURIComponent(record.id.trim())}`;

        return {
          source_id: manifest.source_id,
          external_id: record.id.trim(),
          identity: {
            display_name: record.name.trim(),
            domain,
            phone_e164: sanitizePhone(record.phone_e164),
          },
          collected_at: now,
          source_url: sourceUrl,
          facts,
        };
      });
    },
  };
}

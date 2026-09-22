/**
 * Resolução determinística de aliases de identidade comercial.
 *
 * Em conformidade com o briefing do Opportunity Intelligence:
 * Fontes abertas parciais frequentemente encontram variações da mesma empresa
 * (ex.: "Padaria Alfa LTDA", "Padaria Alfa", "padariaalfa.com.br", "+5511999998888").
 * Este módulo resolve variações e agrupa fontes sem criar leads duplicados.
 */
import {
  canonicalIdentityKey,
  type OpportunityIdentity,
} from "@/lib/opportunity-intelligence/domain";

export type IdentityMatchTier = "registry_id" | "domain" | "phone" | "normalized_name";

export type ResolvedIdentityCluster = {
  canonical_key: string;
  primary_identity: OpportunityIdentity;
  aliases: string[];
  matched_by: IdentityMatchTier;
  confidence: number;
};

const LEGAL_SUFFIXES_REGEX =
  /\b(ltda|me|epp|eireli|s\/a|sa|s\.a\.?|sociedade anonima|mei|inc|llc|corp)\b/gi;
const SANITIZE_REGEX = /[^a-z0-9]/gi;

/**
 * Normaliza o nome fantasia/razão social para comparação determinística:
 * 1. Converte para minúsculas e remove acentuação
 * 2. Remove sufixos societários comuns (LTDA, ME, EPP, etc.)
 * 3. Remove pontuação e caracteres não alfanuméricos
 */
export function normalizeBusinessName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(LEGAL_SUFFIXES_REGEX, "")
    .replace(SANITIZE_REGEX, "")
    .trim();
}

/**
 * Normaliza domínio de site removendo protocolo, www e barras finais.
 */
export function normalizeDomain(rawDomain?: string | null): string | null {
  if (!rawDomain) return null;
  let d = rawDomain.trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, "");
  d = d.replace(/^www\./i, "");
  d = d.split("/")[0] ?? "";
  d = d.split("?")[0] ?? "";
  d = d.trim();
  return d.length > 0 ? d : null;
}

/**
 * Normaliza telefone para formato numérico limpo.
 */
export function normalizePhone(rawPhone?: string | null): string | null {
  if (!rawPhone) return null;
  const digits = rawPhone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  return digits.startsWith("55") ? `+${digits}` : `+55${digits}`;
}

/**
 * Resolve e agrega múltiplas identidades observadas em um único cluster canônico.
 * Ordem hierárquica estrita:
 * 1. registry_id (CNPJ/Tax ID): confiança 1.0
 * 2. domain (Website principal): confiança 0.95
 * 3. phone_e164 (Telefone principal): confiança 0.90
 * 4. normalized_name (Razão social / Fantasia limpa): confiança 0.75
 */
export function resolveIdentityCluster(identities: OpportunityIdentity[]): ResolvedIdentityCluster {
  if (identities.length === 0) {
    throw new Error("Cannot resolve identity cluster from empty list");
  }

  // 1. Prioriza quem tem registry_id
  const withRegistry = identities.find((id) => id.registry_id?.trim());
  if (withRegistry?.registry_id) {
    const canonicalKey = `registry:${withRegistry.registry_id.trim()}`;
    const allAliases = buildAliasList(identities, canonicalKey);
    return {
      canonical_key: canonicalKey,
      primary_identity: selectPrimaryIdentity(identities, withRegistry),
      aliases: allAliases,
      matched_by: "registry_id",
      confidence: 1.0,
    };
  }

  // 2. Prioriza quem tem domain válido
  const withDomain = identities.find((id) => normalizeDomain(id.domain));
  if (withDomain?.domain) {
    const cleanDomain = normalizeDomain(withDomain.domain)!;
    const canonicalKey = `domain:${cleanDomain}`;
    const allAliases = buildAliasList(identities, canonicalKey);
    return {
      canonical_key: canonicalKey,
      primary_identity: selectPrimaryIdentity(identities, withDomain),
      aliases: allAliases,
      matched_by: "domain",
      confidence: 0.95,
    };
  }

  // 3. Prioriza quem tem telefone
  const withPhone = identities.find((id) => normalizePhone(id.phone_e164));
  if (withPhone?.phone_e164) {
    const cleanPhone = normalizePhone(withPhone.phone_e164)!;
    const canonicalKey = `phone:${cleanPhone}`;
    const allAliases = buildAliasList(identities, canonicalKey);
    return {
      canonical_key: canonicalKey,
      primary_identity: selectPrimaryIdentity(identities, withPhone),
      aliases: allAliases,
      matched_by: "phone",
      confidence: 0.9,
    };
  }

  // 4. Fallback determinístico por nome normalizado
  const base = identities[0]!;
  const normalized = normalizeBusinessName(base.display_name);
  const canonicalKey = `name:${normalized}`;
  const allAliases = buildAliasList(identities, canonicalKey);
  return {
    canonical_key: canonicalKey,
    primary_identity: selectPrimaryIdentity(identities, base),
    aliases: allAliases,
    matched_by: "normalized_name",
    confidence: 0.75,
  };
}

function selectPrimaryIdentity(
  all: OpportunityIdentity[],
  preferred: OpportunityIdentity,
): OpportunityIdentity {
  // Mescla o melhor de cada observação (ex.: se preferred tem domain mas não phone, pega phone de outro)
  const domain = preferred.domain ?? all.find((i) => i.domain)?.domain;
  const phone = preferred.phone_e164 ?? all.find((i) => i.phone_e164)?.phone_e164;
  const registry = preferred.registry_id ?? all.find((i) => i.registry_id)?.registry_id;

  return {
    display_name: preferred.display_name,
    domain: normalizeDomain(domain) ?? undefined,
    phone_e164: normalizePhone(phone) ?? undefined,
    registry_id: registry?.trim() ?? undefined,
  };
}

function buildAliasList(identities: OpportunityIdentity[], canonicalKey: string): string[] {
  const aliases = new Set<string>();
  for (const id of identities) {
    const key = canonicalIdentityKey(id);
    if (key !== canonicalKey) {
      aliases.add(key);
    }
    aliases.add(id.display_name);
    if (id.domain) aliases.add(id.domain);
    if (id.phone_e164) aliases.add(id.phone_e164);
  }
  return [...aliases].filter(Boolean);
}

/**
 * POST /api/v1/opportunity-intelligence/intake
 *
 * Entrada controlada para adapters autorizados. O corpo carrega o fato bruto
 * e sua proveniência, mas a organização ativa, o lead existente e o modo de
 * autonomia são resolvidos no servidor. Este endpoint só cria uma proposta;
 * ele nunca envia mensagem.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import {
  canonicalIdentityKey,
  opportunityEvaluationInputSchema,
  opportunityStrategySchema,
  signalSchema,
} from "@/lib/opportunity-intelligence/domain";
import { planOpportunityPipeline } from "@/lib/opportunity-intelligence/pipeline";
import { persistOpportunityPipelinePlan } from "@/lib/opportunity-intelligence/write";
import {
  sourceAdapterManifestSchema,
  sourceCandidateSchema,
  canRunSource,
  validateSourceCandidate,
} from "@/lib/opportunity-intelligence/sources";
import { WEB_PRESENCE_SOURCE_MANIFEST } from "@/lib/opportunity-intelligence/adapters/web-presence";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkOpportunityMutationRate } from "@/lib/opportunity-intelligence/limits";

export const dynamic = "force-dynamic";

const intakeRequestSchema = z.object({
  trace_id: z.string().uuid().optional(),
  opportunity_id: z.string().uuid().optional(),
  region: z.string().trim().min(1).max(80),
  source_manifest: sourceAdapterManifestSchema,
  candidate: sourceCandidateSchema,
  required_signal_keys: z.array(z.string().trim().min(1).max(100)).min(1).max(40),
  signals: z.array(signalSchema).min(1).max(40),
  evidence: opportunityEvaluationInputSchema.shape.evidence,
  strategy: opportunityStrategySchema.nullable(),
  linked_lead_id: z.string().uuid().nullable().optional(),
});

type LeadContext = {
  linked_lead_id: string | null;
  existing_lead: "none" | "active" | "won" | "lost" | "unknown";
  suppressed: boolean;
};

type CandidateIdentity = {
  display_name: string;
  domain?: string;
  phone_e164?: string;
  registry_id?: string;
};

function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function normalizePhone(value?: string): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 8 ? (digits.startsWith("55") ? `+${digits}` : `+55${digits}`) : null;
}

function normalizeDomain(value?: string): string | null {
  if (!value) return null;
  const domain = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
  return domain || null;
}

function isBuiltInManifest(manifest: z.infer<typeof sourceAdapterManifestSchema>): boolean {
  return (
    manifest.source_id === WEB_PRESENCE_SOURCE_MANIFEST.source_id &&
    manifest.source_kind === WEB_PRESENCE_SOURCE_MANIFEST.source_kind &&
    manifest.terms_url === WEB_PRESENCE_SOURCE_MANIFEST.terms_url &&
    manifest.allow_automated_collection ===
      WEB_PRESENCE_SOURCE_MANIFEST.allow_automated_collection &&
    manifest.rate_limit_per_minute === WEB_PRESENCE_SOURCE_MANIFEST.rate_limit_per_minute &&
    manifest.supports_regions.every((region) =>
      WEB_PRESENCE_SOURCE_MANIFEST.supports_regions.includes(region),
    )
  );
}

async function resolveLeadContext(
  client: ReturnType<typeof createAdminClient>,
  organizationId: string,
  linkedLeadId: string | null,
  identity: CandidateIdentity,
): Promise<LeadContext> {
  let lead = null as { id: string; status: string; contact_id: string | null } | null;
  let contact = null as { id: string; is_blocked: boolean } | null;

  if (linkedLeadId) {
    const { data: linkedLead, error: leadError } = await client
      .from("crm_leads")
      .select("id, status, contact_id")
      .eq("organization_id", organizationId)
      .eq("id", linkedLeadId)
      .maybeSingle();

    if (leadError) throw new Error(`opportunity_linked_lead_lookup_failed: ${leadError.message}`);
    if (!linkedLead) throw new Error("opportunity_linked_lead_not_found");
    lead = linkedLead;
  } else {
    const phone = normalizePhone(identity.phone_e164);
    const domain = normalizeDomain(identity.domain);
    let contactQuery = client
      .from("contacts")
      .select("id, is_blocked")
      .eq("organization_id", organizationId);
    if (phone) contactQuery = contactQuery.eq("phone_number", phone);
    else if (domain) contactQuery = contactQuery.ilike("email", `%@${escapeIlike(domain)}`);
    else
      contactQuery = contactQuery.ilike("display_name", escapeIlike(identity.display_name.trim()));

    const contactResult = await contactQuery.maybeSingle();
    if (contactResult.error)
      throw new Error(`opportunity_contact_identity_lookup_failed: ${contactResult.error.message}`);
    contact = contactResult.data;

    let leadQuery = client
      .from("crm_leads")
      .select("id, status, contact_id")
      .eq("organization_id", organizationId);
    if (contact?.id) leadQuery = leadQuery.eq("contact_id", contact.id);
    else leadQuery = leadQuery.ilike("title", escapeIlike(identity.display_name.trim()));
    const leadResult = await leadQuery
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (leadResult.error)
      throw new Error(`opportunity_lead_identity_lookup_failed: ${leadResult.error.message}`);
    lead = leadResult.data;
  }

  if (!lead) {
    return {
      linked_lead_id: null,
      existing_lead: "none",
      suppressed: Boolean(contact?.is_blocked),
    };
  }

  let suppressed = Boolean(contact?.is_blocked);
  if (lead.contact_id) {
    const { data: linkedContact, error: contactError } = await client
      .from("contacts")
      .select("id, is_blocked")
      .eq("organization_id", organizationId)
      .eq("id", lead.contact_id)
      .maybeSingle();
    if (contactError) throw new Error(`opportunity_contact_lookup_failed: ${contactError.message}`);
    suppressed = suppressed || Boolean(linkedContact?.is_blocked);
  }

  const existingLead =
    lead.status === "open"
      ? "active"
      : lead.status === "won"
        ? "won"
        : lead.status === "lost"
          ? "lost"
          : "unknown";
  return { linked_lead_id: lead.id, existing_lead: existingLead, suppressed };
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "opportunity_intelligence_intake",
  });
  if (!authz.ok) return authz.response;
  const rate = await checkOpportunityMutationRate(req, authz.org.orgId, authz.user.id, "intake");
  if (!rate.allowed) {
    return fail("rate_limited", "Muitas entradas de oportunidade em pouco tempo.", 429, {
      requestId,
      headers: { "Retry-After": String(rate.window_sec) },
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("body_malformed", "JSON inválido.", 400, { requestId });
  }

  const parsed = intakeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", "Intake inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = parsed.data;
  const runDecision = canRunSource(input.source_manifest, input.region);
  if (!runDecision.allowed) {
    return fail("source_blocked", `Fonte bloqueada: ${runDecision.reason}.`, 422, { requestId });
  }

  const client = createAdminClient();
  if (!isBuiltInManifest(input.source_manifest)) {
    const { data: configuredSource, error: sourceError } = await client
      .from("opportunity_source_configs")
      .select("source_id, source_kind, terms_url, regions, rate_limit_per_minute, is_active")
      .eq("organization_id", authz.org.orgId)
      .eq("source_id", input.source_manifest.source_id)
      .eq("is_active", true)
      .maybeSingle();

    if (sourceError) {
      return fail("internal_error", "Não foi possível validar a fonte autorizada.", 500, {
        requestId,
      });
    }
    const regions = Array.isArray(configuredSource?.regions) ? configuredSource.regions : [];
    const manifestMatchesConfig =
      configuredSource &&
      configuredSource.source_kind === input.source_manifest.source_kind &&
      configuredSource.terms_url === input.source_manifest.terms_url &&
      configuredSource.rate_limit_per_minute === input.source_manifest.rate_limit_per_minute &&
      regions.length === input.source_manifest.supports_regions.length &&
      regions.every((region: string) => input.source_manifest.supports_regions.includes(region));
    if (!manifestMatchesConfig) {
      return fail(
        "source_not_authorized",
        "A fonte não está autorizada para esta organização.",
        403,
        { requestId },
      );
    }
  }

  let candidate;
  try {
    candidate = validateSourceCandidate(input.candidate, input.source_manifest);
  } catch (error) {
    return fail(
      "source_candidate_invalid",
      error instanceof Error ? error.message : "Candidato inválido.",
      422,
      {
        requestId,
      },
    );
  }

  try {
    const leadContext = await resolveLeadContext(
      client,
      authz.org.orgId,
      input.linked_lead_id ?? null,
      candidate.identity,
    );
    const assessment = {
      opportunity_id: input.opportunity_id ?? randomUUID(),
      candidate: {
        ...candidate,
        identity_key: canonicalIdentityKey(candidate.identity),
        duplicate_source_ids: [],
      },
      required_signal_keys: input.required_signal_keys,
      signals: input.signals,
      evidence: input.evidence,
      strategy: input.strategy,
      // Copiloto é o padrão de segurança do produto; não aceitamos uma
      // permissão de autonomia escondida no payload do adapter.
      tenant_policy: { require_human_approval: true },
      ...leadContext,
    };

    const plan = planOpportunityPipeline({
      trace_id: input.trace_id ?? randomUUID(),
      schema_version: 1,
      organization_id: authz.org.orgId,
      assessments: [assessment],
    });
    const persisted = await persistOpportunityPipelinePlan(client, plan, [assessment], {
      actor_user_id: authz.user.id,
    });

    return ok(
      {
        trace_id: plan.trace_id,
        decision: plan.items[0]?.decision ?? null,
        persisted: persisted.results[0] ?? null,
      },
      { requestId, status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    if (message === "opportunity_linked_lead_not_found") {
      return fail("not_found", "Lead vinculado não encontrado nesta organização.", 404, {
        requestId,
      });
    }
    return fail("internal_error", "Não foi possível processar o intake.", 500, { requestId });
  }
}

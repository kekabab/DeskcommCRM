import { z } from "zod";

import {
  canonicalIdentityKey,
  opportunityIdentitySchema,
  type OpportunityIdentity,
} from "@/lib/opportunity-intelligence/domain";

export const sourceAdapterManifestSchema = z.object({
  source_id: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_.-]{1,79}$/),
  source_kind: z.enum(["open_data", "official_api", "tenant_first_party", "operator_verified"]),
  terms_url: z.string().url(),
  allow_automated_collection: z.boolean(),
  rate_limit_per_minute: z.number().int().min(1).max(100_000),
  supports_regions: z.array(z.string().trim().min(1).max(80)).min(1).max(200),
});

export type SourceAdapterManifest = z.infer<typeof sourceAdapterManifestSchema>;

export const sourceCandidateSchema = z.object({
  source_id: z.string().trim().min(1).max(80),
  external_id: z.string().trim().min(1).max(240),
  identity: opportunityIdentitySchema,
  collected_at: z
    .string()
    .refine((value) => !Number.isNaN(Date.parse(value)), "invalid collected_at"),
  source_url: z.string().url(),
  facts: z.record(z.string(), z.string().trim().max(500)).default({}),
});

export type SourceCandidate = z.infer<typeof sourceCandidateSchema>;

export type DiscoveryQuery = {
  organization_id: string;
  region: string;
  niche: string;
  offer_key: string;
};

export type SourceAdapter = {
  manifest: SourceAdapterManifest;
  discover(query: DiscoveryQuery): Promise<SourceCandidate[]>;
};

export type SourceRunDecision =
  | { allowed: true; reason: "manifest_allows_automated_collection" }
  | { allowed: false; reason: "source_disallows_automation" | "region_not_supported" };

export function canRunSource(
  manifestInput: SourceAdapterManifest,
  region: string,
): SourceRunDecision {
  const manifest = sourceAdapterManifestSchema.parse(manifestInput);

  if (!manifest.allow_automated_collection) {
    return { allowed: false, reason: "source_disallows_automation" };
  }
  if (!manifest.supports_regions.includes(region)) {
    return { allowed: false, reason: "region_not_supported" };
  }
  return { allowed: true, reason: "manifest_allows_automated_collection" };
}

export function validateSourceCandidate(
  candidateInput: SourceCandidate,
  manifestInput: SourceAdapterManifest,
): SourceCandidate {
  const candidate = sourceCandidateSchema.parse(candidateInput);
  const manifest = sourceAdapterManifestSchema.parse(manifestInput);

  if (candidate.source_id !== manifest.source_id) {
    throw new Error("candidate source_id does not match adapter manifest");
  }
  if (!manifest.allow_automated_collection) {
    throw new Error("source does not allow automated collection");
  }
  return candidate;
}

export type DeduplicatedCandidate = SourceCandidate & {
  identity_key: string;
  duplicate_source_ids: string[];
};

export function deduplicateCandidates(candidates: SourceCandidate[]): DeduplicatedCandidate[] {
  const byIdentity = new Map<string, DeduplicatedCandidate>();

  for (const rawCandidate of candidates) {
    const candidate = sourceCandidateSchema.parse(rawCandidate);
    const identity = candidate.identity as OpportunityIdentity;
    const identityKey = canonicalIdentityKey(identity);
    const current = byIdentity.get(identityKey);

    if (!current) {
      byIdentity.set(identityKey, {
        ...candidate,
        identity_key: identityKey,
        duplicate_source_ids: [],
      });
      continue;
    }

    const currentCollectedAt = Date.parse(current.collected_at);
    const candidateCollectedAt = Date.parse(candidate.collected_at);
    const newest = candidateCollectedAt > currentCollectedAt ? candidate : current;
    const sourceIds = new Set([
      ...current.duplicate_source_ids,
      current.source_id,
      candidate.source_id,
    ]);
    sourceIds.delete(newest.source_id);

    byIdentity.set(identityKey, {
      ...newest,
      identity_key: identityKey,
      duplicate_source_ids: [...sourceIds].sort(),
    });
  }

  return [...byIdentity.values()];
}

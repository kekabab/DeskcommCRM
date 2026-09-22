import { describe, expect, it } from "vitest";

import { discoverCandidates } from "@/lib/opportunity-intelligence/discovery";
import type { SourceAdapter, SourceCandidate } from "@/lib/opportunity-intelligence/sources";

const query = {
  organization_id: "00000000-0000-4000-8000-000000000001",
  region: "br-sudeste",
  niche: "clinicas",
  offer_key: "conversion-first-site",
};

const manifest = {
  source_id: "open-places",
  source_kind: "open_data" as const,
  terms_url: "https://example.com/terms",
  allow_automated_collection: true,
  rate_limit_per_minute: 30,
  supports_regions: ["br-sudeste"],
};

function makeCandidate(sourceId = "open-places"): SourceCandidate {
  return {
    source_id: sourceId,
    external_id: "place-1",
    identity: { display_name: "Clínica Aurora", domain: "https://example.com" },
    collected_at: "2026-09-20T15:00:00.000Z",
    source_url: "https://example.com/places/1",
    facts: { category: "clinic" },
  };
}

describe("Opportunity Intelligence discovery pipeline", () => {
  it("collects, validates and deduplicates without failing the whole run", async () => {
    const goodAdapter: SourceAdapter = {
      manifest,
      discover: async () => [makeCandidate()],
    };
    const blockedAdapter: SourceAdapter = {
      manifest: { ...manifest, source_id: "blocked-source", allow_automated_collection: false },
      discover: async () => [makeCandidate("blocked-source")],
    };
    const failingAdapter: SourceAdapter = {
      manifest: { ...manifest, source_id: "failing-source" },
      discover: async () => {
        throw new Error("upstream timeout");
      },
    };

    const result = await discoverCandidates({
      query,
      adapters: [goodAdapter, blockedAdapter, failingAdapter],
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.attempted_source_ids).toEqual(["open-places", "failing-source"]);
    expect(result.blocked_source_ids).toEqual(["blocked-source"]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_id: "blocked-source", code: "source_disallowed" }),
        expect.objectContaining({
          source_id: "failing-source",
          code: "source_failed",
          message: "upstream timeout",
        }),
      ]),
    );
  });

  it("rejects malformed candidates but keeps valid candidates from the same adapter", async () => {
    const adapter: SourceAdapter = {
      manifest,
      discover: async () => [makeCandidate(), { ...makeCandidate(), source_id: "wrong-source" }],
    };

    const result = await discoverCandidates({ query, adapters: [adapter] });

    expect(result.candidates).toHaveLength(1);
    expect(result.errors).toEqual([
      expect.objectContaining({ source_id: "open-places", code: "candidate_rejected" }),
    ]);
  });
});

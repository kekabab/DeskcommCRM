import { describe, expect, it } from "vitest";

import {
  canRunSource,
  deduplicateCandidates,
  validateSourceCandidate,
  type SourceCandidate,
  type SourceAdapterManifest,
} from "@/lib/opportunity-intelligence/sources";

const manifest: SourceAdapterManifest = {
  source_id: "open-places",
  source_kind: "open_data",
  terms_url: "https://example.com/terms",
  allow_automated_collection: true,
  rate_limit_per_minute: 30,
  supports_regions: ["br-sudeste"],
};

function candidate(overrides: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    source_id: "open-places",
    external_id: "place-1",
    identity: { display_name: "Clínica Aurora", domain: "https://www.example.com" },
    collected_at: "2026-09-20T15:00:00.000Z",
    source_url: "https://example.com/places/1",
    facts: { category: "clinic" },
    ...overrides,
  };
}

describe("Opportunity Intelligence source adapters", () => {
  it("blocks sources that do not explicitly allow automated collection", () => {
    expect(canRunSource({ ...manifest, allow_automated_collection: false }, "br-sudeste")).toEqual({
      allowed: false,
      reason: "source_disallows_automation",
    });
  });

  it("blocks regions outside the adapter manifest", () => {
    expect(canRunSource(manifest, "br-norte")).toEqual({
      allowed: false,
      reason: "region_not_supported",
    });
  });

  it("rejects candidates emitted by the wrong adapter", () => {
    expect(() =>
      validateSourceCandidate({ ...candidate(), source_id: "other-source" }, manifest),
    ).toThrow("candidate source_id does not match adapter manifest");
  });

  it("deduplicates identity across sources and keeps the freshest candidate", () => {
    const newest = candidate({
      source_id: "official-directory",
      external_id: "directory-9",
      collected_at: "2026-09-20T16:00:00.000Z",
      source_url: "https://example.com/directory/9",
    });

    const result = deduplicateCandidates([candidate(), newest]);

    expect(result).toHaveLength(1);
    expect(result[0]?.source_id).toBe("official-directory");
    expect(result[0]?.duplicate_source_ids).toEqual(["open-places"]);
  });

  it("does not merge different identities that share a display name", () => {
    const result = deduplicateCandidates([
      candidate({
        identity: { display_name: "Clínica Aurora", domain: "https://aurora.example.com" },
      }),
      candidate({
        external_id: "place-2",
        identity: { display_name: "Clínica Aurora", domain: "https://outra.example.com" },
      }),
    ]);

    expect(result).toHaveLength(2);
  });
});

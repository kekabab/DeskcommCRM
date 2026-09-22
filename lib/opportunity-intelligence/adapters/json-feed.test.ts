import { describe, expect, it } from "vitest";

import {
  createJsonFeedAdapter,
  isPrivateAddress,
} from "@/lib/opportunity-intelligence/adapters/json-feed";

const manifest = {
  source_id: "public-feed",
  source_kind: "open_data" as const,
  terms_url: "https://source.example/terms",
  allow_automated_collection: true,
  rate_limit_per_minute: 30,
  supports_regions: ["GLOBAL"],
};

function candidate(externalId = "company-1") {
  return {
    source_id: manifest.source_id,
    external_id: externalId,
    identity: { display_name: "Company One", domain: "company.example" },
    collected_at: "2026-09-20T15:00:00.000Z",
    source_url: `https://source.example/company/${externalId}`,
    facts: { signal: "observed" },
  };
}

describe("secure JSON feed adapter", () => {
  it("reads a bounded candidate feed and enforces the source identity", async () => {
    const adapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed", max_records_per_run: 1 },
      {
        resolveHost: async () => ["93.184.216.34"],
        fetcher: async () =>
          new Response(JSON.stringify({ candidates: [candidate()] }), { status: 200 }),
      },
    );

    await expect(
      adapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects private hosts before making a request and rejects oversized feeds", async () => {
    const privateAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://127.0.0.1/feed" },
      { fetcher: async () => new Response("{}") },
    );
    await expect(
      privateAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");

    const oversized = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed" },
      {
        resolveHost: async () => ["93.184.216.34"],
        fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1), { status: 200 }),
      },
    );
    await expect(
      oversized.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_payload_too_large");
  });

  it("revalidates HTTPS on redirects and enforces the redirect ceiling", async () => {
    let calls = 0;
    const adapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed" },
      {
        resolveHost: async (hostname) => {
          if (hostname === "private.example") return ["10.0.0.1"];
          return ["93.184.216.34"];
        },
        fetcher: async (url) => {
          calls += 1;
          if (url.endsWith("/feed"))
            return new Response(null, {
              status: 302,
              headers: { location: "https://private.example/feed" },
            });
          return new Response(JSON.stringify([candidate()]), { status: 200 });
        },
      },
    );

    await expect(
      adapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_resolves_to_private_address");
    expect(calls).toBe(1);
  });

  it("rejects IPv4-mapped IPv6, unspecified address, and redirects to mapped private addresses", async () => {
    // Validação direta da função isPrivateAddress
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("0:0:0:0:0:0:0:0")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);

    // URL direta com IPv4-mapped IPv6
    const mappedLiteralAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://[::ffff:127.0.0.1]/feed" },
      { fetcher: async () => new Response("{}") },
    );
    await expect(
      mappedLiteralAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");

    // URL com endereço não especificado ::
    const unspecifiedAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://[::]/feed" },
      { fetcher: async () => new Response("{}") },
    );
    await expect(
      unspecifiedAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");

    // Host que resolve para IPv4-mapped IPv6
    const mappedDnsAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed" },
      {
        resolveHost: async () => ["::ffff:127.0.0.1"],
        fetcher: async () => new Response("{}"),
      },
    );
    await expect(
      mappedDnsAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_resolves_to_private_address");

    // Redirect que aponta para IPv4-mapped IPv6
    const redirectAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed" },
      {
        resolveHost: async () => ["93.184.216.34"],
        fetcher: async (url) => {
          if (url.endsWith("/feed")) {
            return new Response(null, {
              status: 302,
              headers: { location: "https://[::ffff:127.0.0.1]/feed" },
            });
          }
          return new Response(JSON.stringify([candidate()]), { status: 200 });
        },
      },
    );
    await expect(
      redirectAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");
  });

  it("enforces comprehensive IPv6 anti-SSRF for ULA, link-local, IPv4-compatible and bracketed URLs", async () => {
    // Validação de endereços ULA (fc00::/7)
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fd12:3456:789a:1::1")).toBe(true);

    // Validação de endereços Link-Local (fe80::/10)
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fe90::1")).toBe(true);
    expect(isPrivateAddress("fea0::1")).toBe(true);
    expect(isPrivateAddress("feb0::1")).toBe(true);

    // Validação de endereços IPv4-compatible IPv6 (obsoleto, ex: ::127.0.0.1, ::10.0.0.1)
    expect(isPrivateAddress("::127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::192.168.0.1")).toBe(true);

    // Endereços públicos IPv6 legítimos NÃO devem ser bloqueados
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("2800:3f0:4001:815::200e")).toBe(false);

    // Rejeição direta de URLs com literais IPv6 privados entre colchetes
    const loopbackLiteralAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://[::1]/feed" },
      { fetcher: async () => new Response("{}") },
    );
    await expect(
      loopbackLiteralAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");

    const ulaLiteralAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://[fd00::1]/feed" },
      { fetcher: async () => new Response("{}") },
    );
    await expect(
      ulaLiteralAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");

    const linkLocalLiteralAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://[fe80::1]/feed" },
      { fetcher: async () => new Response("{}") },
    );
    await expect(
      linkLocalLiteralAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_private_address");

    // Rejeição via resolução DNS que retorna IPv6 ULA ou Link-Local
    const ulaDnsAdapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed" },
      {
        resolveHost: async () => ["fd12:3456:789a:1::1"],
        fetcher: async () => new Response("{}"),
      },
    );
    await expect(
      ulaDnsAdapter.discover({
        organization_id: "00000000-0000-4000-8000-000000000001",
        region: "GLOBAL",
        niche: "x",
        offer_key: "y",
      }),
    ).rejects.toThrow("feed_url_resolves_to_private_address");

    // Aceitação de host público resolvendo para IPv6 público legítimo
    const publicIpv6Adapter = createJsonFeedAdapter(
      { manifest, feed_url: "https://source.example/feed", max_records_per_run: 1 },
      {
        resolveHost: async () => ["2001:4860:4860::8888"],
        fetcher: async () =>
          new Response(JSON.stringify({ candidates: [candidate("ipv6-co-1")] }), { status: 200 }),
      },
    );
    const results = await publicIpv6Adapter.discover({
      organization_id: "00000000-0000-4000-8000-000000000001",
      region: "GLOBAL",
      niche: "x",
      offer_key: "y",
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.external_id).toBe("ipv6-co-1");
  });
});

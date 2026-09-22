import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { z } from "zod";

import {
  sourceAdapterManifestSchema,
  sourceCandidateSchema,
  type SourceAdapter,
  type SourceAdapterManifest,
  type SourceCandidate,
} from "@/lib/opportunity-intelligence/sources";

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 2;
const FEED_TIMEOUT_MS = 15_000;

export const jsonFeedConfigSchema = z.object({
  manifest: sourceAdapterManifestSchema,
  feed_url: z.string().url(),
  max_records_per_run: z.number().int().min(1).max(100).default(100),
});

export type JsonFeedConfig = z.infer<typeof jsonFeedConfigSchema>;

type HostResolver = (hostname: string) => Promise<string[]>;
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, "");
  const v = isIP(normalized);
  if (v === 4) {
    const octets = normalized.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (v === 6) {
    // Endereço não especificado (:: ou ::/0 ou todo zerado)
    if (normalized === "::" || normalized.replace(/[:0]/g, "") === "") {
      return true;
    }
    // Loopback IPv6
    if (normalized === "::1") {
      return true;
    }
    // IPv4-mapped IPv6 (ex: ::ffff:127.0.0.1 ou ::ffff:10.0.0.1 ou ::ffff:192.168.1.1)
    const mappedDottedMatch = normalized.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDottedMatch) {
      return isPrivateAddress(mappedDottedMatch[1]!);
    }
    const mappedHexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHexMatch) {
      const hi = parseInt(mappedHexMatch[1]!, 16);
      const lo = parseInt(mappedHexMatch[2]!, 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      return isPrivateAddress(`${a}.${b}.${c}.${d}`);
    }
    // IPv4-compatible IPv6 (obsoleto, ex: ::127.0.0.1)
    const compatDottedMatch = normalized.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (compatDottedMatch) {
      return isPrivateAddress(compatDottedMatch[1]!);
    }
    // ULA (Unique Local Address: fc00::/7)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }
    // Link-local unicast (fe80::/10)
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }
  }
  return false;
}

export async function assertPublicHttpsUrl(
  rawUrl: string,
  resolveHost: HostResolver = async (hostname) =>
    (await lookup(hostname, { all: true })).map((entry) => entry.address),
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("feed_url_invalid");
  }
  if (url.protocol !== "https:") throw new Error("feed_url_must_use_https");
  const hostname = url.hostname.toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    throw new Error("feed_url_private_hostname");
  }
  if (isPrivateAddress(hostname)) throw new Error("feed_url_private_address");

  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("feed_url_resolves_to_private_address");
  }
  return url;
}

async function readFeed(
  inputUrl: string,
  fetcher: Fetcher,
  resolveHost: HostResolver,
  redirects = 0,
): Promise<unknown> {
  const url = await assertPublicHttpsUrl(inputUrl, resolveHost);
  const response = await fetcher(url.toString(), {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    if (redirects >= MAX_REDIRECTS) throw new Error("feed_redirect_limit_exceeded");
    const location = response.headers.get("location");
    if (!location) throw new Error("feed_redirect_without_location");
    return readFeed(new URL(location, url).toString(), fetcher, resolveHost, redirects + 1);
  }
  if (!response.ok) throw new Error(`feed_http_${response.status}`);

  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAX_FEED_BYTES)
    throw new Error("feed_payload_too_large");
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("feed_payload_invalid_json");
  }
}

function candidatesFromPayload(
  payload: unknown,
  manifest: SourceAdapterManifest,
  maxRecords: number,
): SourceCandidate[] {
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && "candidates" in payload
      ? (payload as { candidates: unknown }).candidates
      : null;
  if (!Array.isArray(values)) throw new Error("feed_payload_must_be_candidate_array");

  return z
    .array(sourceCandidateSchema)
    .max(maxRecords)
    .parse(values)
    .map((candidate) => {
      if (candidate.source_id !== manifest.source_id)
        throw new Error("feed_candidate_source_mismatch");
      return candidate;
    });
}

export function createJsonFeedAdapter(
  rawConfig: z.input<typeof jsonFeedConfigSchema>,
  deps: { fetcher?: Fetcher; resolveHost?: HostResolver } = {},
): SourceAdapter {
  const config = jsonFeedConfigSchema.parse(rawConfig);
  const fetcher: Fetcher =
    deps.fetcher ??
    (async (input, init) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
      try {
        return await fetch(input, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    });
  const resolveHost = deps.resolveHost;

  return {
    manifest: config.manifest,
    async discover(): Promise<SourceCandidate[]> {
      const payload = await readFeed(
        config.feed_url,
        fetcher,
        resolveHost ??
          (async (hostname) =>
            (await lookup(hostname, { all: true })).map((entry) => entry.address)),
      );
      return candidatesFromPayload(payload, config.manifest, config.max_records_per_run);
    },
  };
}

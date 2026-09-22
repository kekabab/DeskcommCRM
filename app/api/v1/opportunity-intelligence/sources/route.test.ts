/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase chain mocks intentionally model only the exercised surface. */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { assertPublicHttpsUrl } from "@/lib/opportunity-intelligence/adapters/json-feed";
import { createClient } from "@/lib/supabase/server";
import { GET, POST } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));
vi.mock("@/lib/opportunity-intelligence/adapters/json-feed", () => ({
  assertPublicHttpsUrl: vi.fn().mockResolvedValue(new URL("https://valid.example.com")),
}));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

describe("GET & POST /api/v1/opportunity-intelligence/sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertPublicHttpsUrl).mockResolvedValue(new URL("https://valid.example.com"));
  });

  it("rejection fail-closed when user lacks manager role", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    } as any);

    const res = await GET();
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
  });

  it("returns sources with operational status and effective tenant quota for manager", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      org: { orgId: ORG_ID },
      user: { id: USER_ID },
    } as any);

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "opportunity_source_configs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((col: string, _val: string) => {
                if (col === "organization_id") {
                  return {
                    order: vi.fn().mockResolvedValue({
                      data: [
                        {
                          id: "src-1",
                          organization_id: ORG_ID,
                          source_id: "public-feed",
                          name: "Feed Público",
                          source_kind: "open_data",
                          feed_url: "https://feed.example.com/data.json",
                          terms_url: "https://feed.example.com/terms",
                          regions: ["SP"],
                          niche: "tech",
                          offer_key: "audit",
                          rate_limit_per_minute: 60,
                          max_records_per_run: 50,
                          is_active: true,
                          last_synced_at: "2026-09-20T19:00:00.000Z",
                          last_error: null,
                          created_at: "2026-09-20T18:00:00.000Z",
                          updated_at: "2026-09-20T19:00:00.000Z",
                        },
                      ],
                    }),
                    then: (resolve: any) =>
                      resolve({
                        data: [{ id: "src-1", is_active: true }],
                      }),
                  };
                }
                return { order: vi.fn().mockResolvedValue({ data: [] }) };
              }),
            }),
          };
        }
        if (table === "opportunity_discovery_runs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                order: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue({
                    data: [
                      {
                        id: "run-10",
                        source_id: "public-feed",
                        source_config_id: "src-1",
                        window_key: "2026-09-20T19",
                        status: "succeeded",
                        candidates_seen: 20,
                        opportunities_created: 5,
                        errors: [],
                        started_at: "2026-09-20T19:00:00.000Z",
                        finished_at: "2026-09-20T19:01:00.000Z",
                      },
                    ],
                  }),
                }),
                gte: vi.fn().mockResolvedValue({ count: 1 }),
              }),
            }),
          };
        }
        if (table === "organizations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: { settings: {} } }),
              }),
            }),
          };
        }
        if (table === "opportunity_records") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation(() => ({
                gte: vi.fn().mockResolvedValue({ count: 5 }),
                then: (resolve: any) => resolve({ count: 25 }),
              })),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    vi.mocked(createClient).mockResolvedValueOnce(mockClient as any);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.sources).toHaveLength(1);
    expect(json.data.sources[0].source_id).toBe("public-feed");
    expect(json.data.sources[0].status).toBe("healthy");
    expect(json.data.sources[0].last_execution?.run_id).toBe("run-10");

    expect(json.data.quota.organization_id).toBe(ORG_ID);
    expect(json.data.quota.sources.max_active).toBe(5);
    expect(json.data.quota.sources.current_active).toBe(1);
    expect(json.data.quota.governance.copilot_mode).toBe(true);
    expect(json.data.quota.governance.outbound_status).toBe("blocked");
  });

  it("POST enforces tenant quota and blocks activation when quota is exceeded", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      org: { orgId: ORG_ID },
      user: { id: USER_ID },
    } as any);

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "opportunity_source_configs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation((_col: string, _val: string) => ({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null }), // not existing
                }),
                then: (resolve: any) =>
                  resolve({
                    data: [
                      { id: "s1", is_active: true },
                      { id: "s2", is_active: true },
                    ],
                  }),
              })),
            }),
          };
        }
        if (table === "organizations") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    settings: {
                      opportunity_ai: { max_active_sources: 2 }, // Limit is 2 and 2 are active!
                    },
                  },
                }),
              }),
            }),
          };
        }
        if (table === "opportunity_records" || table === "opportunity_discovery_runs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation(() => ({
                gte: vi.fn().mockResolvedValue({ count: 0 }),
                then: (resolve: any) => resolve({ count: 0 }),
              })),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    vi.mocked(createClient).mockResolvedValueOnce(mockClient as any);

    const req = new NextRequest("http://localhost/api/v1/opportunity-intelligence/sources", {
      method: "POST",
      body: JSON.stringify({
        source_id: "new-source",
        name: "Nova Fonte",
        source_kind: "open_data",
        feed_url: "https://valid.example.com/feed.json",
        terms_url: "https://valid.example.com/terms",
        regions: ["SP"],
        is_active: true,
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("quota_exceeded");
    expect(json.error.message).toContain("Limite de fontes ativas atingido");
  });
});

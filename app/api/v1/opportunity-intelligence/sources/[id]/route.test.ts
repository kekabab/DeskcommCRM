/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase chain mocks intentionally model only the exercised surface. */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { DELETE, GET, PATCH } from "./route";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const SOURCE_UUID = "11111111-1111-4000-8000-000000000001";

describe("GET /api/v1/opportunity-intelligence/sources/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails closed (403) when user lacks manager role", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    } as any);

    const req = new NextRequest("http://localhost/api/v1/opportunity-intelligence/sources/123");
    const res = await GET(req, { params: Promise.resolve({ id: "123" }) });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("forbidden");
  });

  it("returns 404 when source does not exist for tenant", async () => {
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
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "opportunity_discovery_runs" || table === "opportunity_records") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockImplementation(() => ({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({ data: [] }),
                  }),
                }),
                gte: vi.fn().mockResolvedValue({ count: 0 }),
                then: (resolve: any) => resolve({ data: [], count: 0 }),
              })),
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
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    vi.mocked(createClient).mockResolvedValueOnce(mockClient as any);

    const req = new NextRequest(
      `http://localhost/api/v1/opportunity-intelligence/sources/${SOURCE_UUID}`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: SOURCE_UUID }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe("not_found");
  });

  it("returns 200 with source view, recent runs and quota when source exists", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      org: { orgId: ORG_ID },
      user: { id: USER_ID },
    } as any);

    const sampleSource = {
      id: SOURCE_UUID,
      organization_id: ORG_ID,
      source_id: "places-feed",
      name: "Google Places Feed",
      source_kind: "open_data",
      feed_url: "https://feed.example.com/places",
      terms_url: "https://feed.example.com/terms",
      regions: ["SP"],
      niche: "clinicas",
      offer_key: "opt",
      rate_limit_per_minute: 60,
      max_records_per_run: 50,
      is_active: true,
      last_synced_at: "2026-09-20T19:00:00.000Z",
      last_error: null,
      created_at: "2026-09-20T18:00:00.000Z",
      updated_at: "2026-09-20T19:00:00.000Z",
    };

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "opportunity_source_configs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({ data: sampleSource, error: null }),
                }),
                then: (resolve: any) => resolve({ data: [sampleSource] }),
              }),
            }),
          };
        }
        if (table === "opportunity_discovery_runs") {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: [
                        {
                          id: "run-1",
                          source_id: "places-feed",
                          source_config_id: SOURCE_UUID,
                          window_key: "2026-09-20T19",
                          status: "succeeded",
                          candidates_seen: 10,
                          opportunities_created: 2,
                          errors: [],
                          started_at: "2026-09-20T19:00:00.000Z",
                          finished_at: "2026-09-20T19:01:00.000Z",
                        },
                      ],
                    }),
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
                then: (resolve: any) => resolve({ count: 20 }),
              })),
            }),
          };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    vi.mocked(createClient).mockResolvedValueOnce(mockClient as any);

    const req = new NextRequest(
      `http://localhost/api/v1/opportunity-intelligence/sources/${SOURCE_UUID}`,
    );
    const res = await GET(req, { params: Promise.resolve({ id: SOURCE_UUID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.source.source_id).toBe("places-feed");
    expect(json.data.source.status).toBe("healthy");
    expect(json.data.recent_runs).toHaveLength(1);
    expect(json.data.recent_runs[0].run_id).toBe("run-1");
    expect(json.data.quota.organization_id).toBe(ORG_ID);
  });
});

describe("PATCH /api/v1/opportunity-intelligence/sources/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails with 422 quota_exceeded when activating an inactive source exceeding tenant limit", async () => {
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
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: { id: SOURCE_UUID, is_active: false }, // Currently inactive
                    error: null,
                  }),
                }),
                then: (resolve: any) =>
                  resolve({
                    data: [
                      { id: "s1", is_active: true },
                      { id: "s2", is_active: true },
                    ],
                  }),
              }),
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

    const req = new NextRequest(
      `http://localhost/api/v1/opportunity-intelligence/sources/${SOURCE_UUID}`,
      {
        method: "PATCH",
        body: JSON.stringify({ is_active: true }),
      },
    );

    const res = await PATCH(req, { params: Promise.resolve({ id: SOURCE_UUID }) });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe("quota_exceeded");
    expect(json.error.message).toContain("Limite de fontes ativas atingido");
  });
});

describe("DELETE /api/v1/opportunity-intelligence/sources/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes source configuration with tenant isolation", async () => {
    vi.mocked(requireRole).mockResolvedValueOnce({
      ok: true,
      org: { orgId: ORG_ID },
      user: { id: USER_ID },
    } as any);

    const eqId = vi.fn().mockResolvedValue({ error: null });
    const eqOrg = vi.fn().mockReturnValue({ eq: eqId });
    const deleteFn = vi.fn().mockReturnValue({ eq: eqOrg });

    const mockClient = {
      from: vi.fn((table: string) => {
        if (table === "opportunity_source_configs") {
          return { delete: deleteFn };
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    vi.mocked(createClient).mockResolvedValueOnce(mockClient as any);

    const req = new NextRequest(
      `http://localhost/api/v1/opportunity-intelligence/sources/${SOURCE_UUID}`,
      {
        method: "DELETE",
      },
    );

    const res = await DELETE(req, { params: Promise.resolve({ id: SOURCE_UUID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.deleted).toBe(true);
    expect(json.data.id).toBe(SOURCE_UUID);

    expect(mockClient.from).toHaveBeenCalledWith("opportunity_source_configs");
    expect(deleteFn).toHaveBeenCalled();
    expect(eqOrg).toHaveBeenCalledWith("organization_id", ORG_ID);
    expect(eqId).toHaveBeenCalledWith("id", SOURCE_UUID);
  });
});

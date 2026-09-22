/* eslint-disable @typescript-eslint/no-explicit-any -- the test client is a minimal typed Supabase double. */
import { describe, expect, it, vi } from "vitest";

import {
  deriveSourceStatus,
  getTenantOpportunityQuota,
  loadOpportunitySourceViews,
} from "@/lib/opportunity-intelligence/quotas";

describe("Opportunity Intelligence — Quotas and Source Status", () => {
  describe("deriveSourceStatus", () => {
    it("returns inactive when source.is_active is false", () => {
      expect(deriveSourceStatus({ is_active: false })).toBe("inactive");
      expect(deriveSourceStatus({ is_active: false, last_error: "Some error" })).toBe("inactive");
      expect(deriveSourceStatus({ is_active: false }, { status: "succeeded" })).toBe("inactive");
    });

    it("returns running when latest run is running", () => {
      expect(deriveSourceStatus({ is_active: true }, { status: "running" })).toBe("running");
    });

    it("returns failed when source has last_error or run failed", () => {
      expect(deriveSourceStatus({ is_active: true, last_error: "Connection refused" })).toBe(
        "failed",
      );
      expect(
        deriveSourceStatus(
          { is_active: true },
          { status: "failed", errors: [{ message: "Timeout" }] },
        ),
      ).toBe("failed");
    });

    it("returns healthy when latest run succeeded and no error", () => {
      expect(
        deriveSourceStatus({ is_active: true, last_error: null }, { status: "succeeded" }),
      ).toBe("healthy");
    });

    it("returns idle when source is active but has not run or skipped", () => {
      expect(deriveSourceStatus({ is_active: true, last_error: null }, null)).toBe("idle");
      expect(deriveSourceStatus({ is_active: true, last_error: null }, { status: "skipped" })).toBe(
        "idle",
      );
    });
  });

  describe("getTenantOpportunityQuota", () => {
    it("computes effective tenant quota with canonical defaults and outbound blocked", async () => {
      const orgId = "00000000-0000-4000-8000-000000000001";
      const mockClient = {
        from: vi.fn((table: string) => {
          if (table === "opportunity_source_configs") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockResolvedValue({
                  data: [
                    { id: "src-1", is_active: true },
                    { id: "src-2", is_active: true },
                    { id: "src-3", is_active: false },
                  ],
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
                        opportunity_ai: {
                          max_active_sources: 3,
                          monthly_limit: 300,
                        },
                      },
                    },
                  }),
                }),
              }),
            };
          }
          if (table === "opportunity_records") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockImplementation((_col: string, _val: string) => ({
                  gte: vi.fn().mockResolvedValue({ count: 42 }),
                  then: (resolve: any) => resolve({ count: 120 }),
                })),
              }),
            };
          }
          if (table === "opportunity_discovery_runs") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockResolvedValue({ count: 12 }),
                }),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      } as any;

      const quota = await getTenantOpportunityQuota(mockClient, orgId);

      expect(quota.organization_id).toBe(orgId);
      expect(quota.sources.max_active).toBe(3);
      expect(quota.sources.current_active).toBe(2);
      expect(quota.sources.total_registered).toBe(3);
      expect(quota.sources.can_activate_more).toBe(true);

      expect(quota.opportunities.monthly_limit).toBe(300);
      expect(quota.opportunities.created_this_month).toBe(42);
      expect(quota.opportunities.remaining_this_month).toBe(258);
      expect(quota.opportunities.total_records).toBe(120);

      expect(quota.sweeps.max_records_per_run_ceiling).toBe(100);
      expect(quota.sweeps.sweeps_today).toBe(12);

      expect(quota.rate_limits.intake_per_minute).toBe(60);
      expect(quota.rate_limits.action_review_per_minute).toBe(120);
      expect(quota.rate_limits.outcome_per_minute).toBe(120);
      expect(quota.rate_limits.window_seconds).toBe(60);

      expect(quota.token_bucket.capacity).toBe(100);
      expect(quota.token_bucket.refill_rate_per_minute).toBe(10);

      expect(quota.governance.copilot_mode).toBe(true);
      expect(quota.governance.outbound_status).toBe("blocked");
    });

    it("fails closed with sanitized error message if sources query fails", async () => {
      const orgId = "00000000-0000-4000-8000-000000000001";
      const mockClient = {
        from: vi.fn((table: string) => {
          if (table === "opportunity_source_configs") {
            return {
              select: () => ({
                eq: async () => ({
                  data: null,
                  error: { code: "57014", message: "query canceled" },
                }),
              }),
            };
          }
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: { settings: {} }, error: null }),
                }),
              }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                gte: async () => ({ count: 0, error: null }),
                then: (resolve: any) => resolve({ count: 0, error: null }),
              }),
            }),
          };
        }),
      } as any;

      await expect(getTenantOpportunityQuota(mockClient, orgId)).rejects.toThrow(
        "tenant_quota_sources_read_failed",
      );
    });

    it("fails closed if organizations query fails", async () => {
      const orgId = "00000000-0000-4000-8000-000000000001";
      const mockClient = {
        from: vi.fn((table: string) => {
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: null,
                    error: { code: "08006", message: "connection failure" },
                  }),
                }),
              }),
            };
          }
          if (table === "opportunity_source_configs") {
            return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
          }
          return {
            select: () => ({
              eq: () => ({
                gte: async () => ({ count: 0, error: null }),
                then: (resolve: any) => resolve({ count: 0, error: null }),
              }),
            }),
          };
        }),
      } as any;

      await expect(getTenantOpportunityQuota(mockClient, orgId)).rejects.toThrow(
        "tenant_quota_settings_read_failed",
      );
    });

    it("fails closed if records queries or discovery runs query fails", async () => {
      const orgId = "00000000-0000-4000-8000-000000000001";
      const mockClientRunsError = {
        from: vi.fn((table: string) => {
          if (table === "opportunity_discovery_runs") {
            return {
              select: () => ({
                eq: () => ({
                  gte: async () => ({
                    count: null,
                    error: { code: "40001", message: "serialization failure" },
                  }),
                }),
              }),
            };
          }
          if (table === "opportunity_source_configs") {
            return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
          }
          if (table === "organizations") {
            return {
              select: () => ({
                eq: () => ({ maybeSingle: async () => ({ data: { settings: {} }, error: null }) }),
              }),
            };
          }
          return {
            select: () => ({
              eq: () => ({
                gte: async () => ({ count: 0, error: null }),
                then: (resolve: any) => resolve({ count: 0, error: null }),
              }),
            }),
          };
        }),
      } as any;

      await expect(getTenantOpportunityQuota(mockClientRunsError, orgId)).rejects.toThrow(
        "tenant_quota_sweeps_read_failed",
      );
    });
  });

  describe("loadOpportunitySourceViews", () => {
    it("enriches sources with operational status, last execution, and quota", async () => {
      const orgId = "00000000-0000-4000-8000-000000000001";
      const mockClient = {
        from: vi.fn((table: string) => {
          if (table === "opportunity_source_configs") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  order: vi.fn().mockResolvedValue({
                    data: [
                      {
                        id: "src-1",
                        organization_id: orgId,
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
                      },
                    ],
                  }),
                }),
              }),
            };
          }
          if (table === "opportunity_discovery_runs") {
            return {
              select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  gte: vi.fn().mockResolvedValue({ count: 1 }),
                  order: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue({
                      data: [
                        {
                          id: "run-1",
                          source_id: "places-feed",
                          source_config_id: "src-1",
                          window_key: "2026-09-20T19",
                          status: "succeeded",
                          candidates_seen: 15,
                          opportunities_created: 3,
                          errors: [],
                          started_at: "2026-09-20T19:00:00.000Z",
                          finished_at: "2026-09-20T19:01:00.000Z",
                        },
                      ],
                    }),
                  }),
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
                  gte: vi.fn().mockResolvedValue({ count: 10 }),
                  then: (resolve: any) => resolve({ count: 50 }),
                })),
              }),
            };
          }
          throw new Error(`Unexpected table ${table}`);
        }),
      } as any;

      const { sources, quota } = await loadOpportunitySourceViews(mockClient, orgId);

      expect(sources).toHaveLength(1);
      expect(sources[0]?.source_id).toBe("places-feed");
      expect(sources[0]?.status).toBe("healthy");
      expect(sources[0]?.last_execution?.run_id).toBe("run-1");
      expect(sources[0]?.last_execution?.candidates_seen).toBe(15);
      expect(sources[0]?.last_execution?.opportunities_created).toBe(3);

      expect(quota.organization_id).toBe(orgId);
      expect(quota.sources.max_active).toBe(5);
      expect(quota.governance.outbound_status).toBe("blocked");
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  calculateTokenBucketConsumption,
  type TokenBucketConfig,
  type TokenBucketState,
} from "@/lib/opportunity-intelligence/limits";

describe("Token-Bucket Tenant Quota Algorithm", () => {
  const testConfig: TokenBucketConfig = {
    capacity: 50,
    refillRatePerMinute: 10,
  };

  it("permits execution and deducts tokens when balance is sufficient", () => {
    const state: TokenBucketState = {
      tokens: 30,
      lastRefillAt: "2026-09-20T12:00:00.000Z",
    };

    const result = calculateTokenBucketConsumption(
      state,
      5,
      testConfig,
      "2026-09-20T12:00:00.000Z",
    );

    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(25);
    expect(result.retryAfterSeconds).toBe(0);
    expect(result.nextState.tokens).toBe(25);
  });

  it("refills tokens over elapsed time up to capacity limit", () => {
    const state: TokenBucketState = {
      tokens: 20,
      lastRefillAt: "2026-09-20T12:00:00.000Z",
    };

    // 2 minutes later -> 20 tokens refilled (total 40), deduct 10 -> 30 left
    const result = calculateTokenBucketConsumption(
      state,
      10,
      testConfig,
      "2026-09-20T12:02:00.000Z",
    );

    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(30);
    expect(result.nextState.tokens).toBe(30);
  });

  it("caps refilled tokens strictly at capacity", () => {
    const state: TokenBucketState = {
      tokens: 45,
      lastRefillAt: "2026-09-20T12:00:00.000Z",
    };

    // 10 minutes later -> should cap at capacity 50, deduct 5 -> 45 left
    const result = calculateTokenBucketConsumption(
      state,
      5,
      testConfig,
      "2026-09-20T12:10:00.000Z",
    );

    expect(result.allowed).toBe(true);
    expect(result.remainingTokens).toBe(45);
  });

  it("rejects consumption and computes accurate retryAfterSeconds when tokens are insufficient", () => {
    const state: TokenBucketState = {
      tokens: 2,
      lastRefillAt: "2026-09-20T12:00:00.000Z",
    };

    // Need 10 tokens, only have 2 (deficit 8).
    // At 10 tokens/min, 8 tokens takes 0.8 min = 48 seconds.
    const result = calculateTokenBucketConsumption(
      state,
      10,
      testConfig,
      "2026-09-20T12:00:00.000Z",
    );

    expect(result.allowed).toBe(false);
    expect(result.remainingTokens).toBe(2);
    expect(result.retryAfterSeconds).toBe(48);
  });

  describe("Production Hardening & Edge Cases", () => {
    it("rejects negative cost without minting tokens", () => {
      const state: TokenBucketState = {
        tokens: 15,
        lastRefillAt: "2026-09-20T12:00:00.000Z",
      };

      const result = calculateTokenBucketConsumption(
        state,
        -10, // Attempted negative cost exploit
        testConfig,
        "2026-09-20T12:00:00.000Z",
      );

      expect(result.allowed).toBe(false);
      expect(result.remainingTokens).toBe(15);
      expect(result.nextState.tokens).toBe(15);
    });

    it("rejects zero or non-finite cost", () => {
      const state: TokenBucketState = {
        tokens: 15,
        lastRefillAt: "2026-09-20T12:00:00.000Z",
      };

      const resZero = calculateTokenBucketConsumption(state, 0, testConfig);
      expect(resZero.allowed).toBe(false);
      expect(resZero.remainingTokens).toBe(15);

      const resNaN = calculateTokenBucketConsumption(state, Number.NaN, testConfig);
      expect(resNaN.allowed).toBe(false);

      const resInf = calculateTokenBucketConsumption(state, Number.POSITIVE_INFINITY, testConfig);
      expect(resInf.allowed).toBe(false);
    });

    it("guards strictly against division by zero when refillRate is 0 or negative", () => {
      const state: TokenBucketState = {
        tokens: 5,
        lastRefillAt: "2026-09-20T12:00:00.000Z",
      };

      const brokenConfig = { capacity: 50, refillRatePerMinute: 0 };
      const result = calculateTokenBucketConsumption(
        state,
        10,
        brokenConfig,
        "2026-09-20T12:00:00.000Z",
      );

      // Falls back to safe default refill rate without crashing with Infinity
      expect(Number.isFinite(result.retryAfterSeconds)).toBe(true);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("handles malformed timestamps safely without throwing or NaN", () => {
      const state: TokenBucketState = {
        tokens: 20,
        lastRefillAt: "invalid-date",
      };

      const result = calculateTokenBucketConsumption(state, 5, testConfig, "also-invalid");

      expect(result.allowed).toBe(true);
      expect(Number.isFinite(result.remainingTokens)).toBe(true);
    });
  });
});

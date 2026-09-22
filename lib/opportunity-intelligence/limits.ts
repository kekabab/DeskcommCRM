import type { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

export const OPPORTUNITY_MUTATION_WINDOW_SECONDS = 60;

export const OPPORTUNITY_MUTATION_LIMITS = {
  intake: 60,
  action_review: 120,
  outcome: 120,
} as const;

const WINDOW_SECONDS = OPPORTUNITY_MUTATION_WINDOW_SECONDS;
const LIMITS = OPPORTUNITY_MUTATION_LIMITS;

export type OpportunityMutationKind = keyof typeof LIMITS;

/**
 * Limits authenticated mutations by tenant + user + observed client IP.
 * The user/org pair prevents forged forwarding headers from bypassing the
 * budget; the IP dimension contains a compromised session's burst.
 */
export async function checkOpportunityMutationRate(
  req: NextRequest,
  organizationId: string,
  userId: string,
  kind: OpportunityMutationKind,
) {
  const ip = ipDoCliente(req.headers) ?? "no-ip";
  return checkRateLimit(
    `opportunity:${kind}:${organizationId}:${userId}:${ip}`,
    LIMITS[kind],
    WINDOW_SECONDS,
  );
}

export type TokenBucketConfig = {
  capacity: number;
  refillRatePerMinute: number;
};

export type TokenBucketState = {
  tokens: number;
  lastRefillAt: string;
};

export type QuotaCheckResult = {
  allowed: boolean;
  remainingTokens: number;
  retryAfterSeconds: number;
  nextState: TokenBucketState;
};

export const DEFAULT_TENANT_SOURCE_QUOTA: TokenBucketConfig = {
  capacity: 100,
  refillRatePerMinute: 10,
};

/**
 * Deterministic Token-Bucket algorithm for tenant discovery quota management.
 * Pure function: takes state, cost, config, and timestamp, returns quota decision and next state.
 *
 * Production hardening:
 * - Cost must be a positive finite number (> 0). Invalid/negative cost returns allowed: false deterministically (prevents minting tokens).
 * - Capacity and refill rate must be positive finite numbers (> 0). Falls back to canonical defaults (prevents division by zero).
 * - Timestamps are checked for finiteness before calculation; invalid timestamps fall back safely without NaN propagation.
 */
export function calculateTokenBucketConsumption(
  state: TokenBucketState,
  cost: number,
  config: TokenBucketConfig = DEFAULT_TENANT_SOURCE_QUOTA,
  nowIso: string = new Date().toISOString(),
): QuotaCheckResult {
  const safeTokens = Number.isFinite(state?.tokens) ? Math.max(0, state.tokens) : 0;

  // Validate cost deterministically (must be finite positive number > 0)
  if (!Number.isFinite(cost) || cost <= 0) {
    return {
      allowed: false,
      remainingTokens: safeTokens,
      retryAfterSeconds: 0,
      nextState: {
        tokens: safeTokens,
        lastRefillAt: Number.isFinite(Date.parse(state?.lastRefillAt))
          ? state.lastRefillAt
          : nowIso,
      },
    };
  }

  // Validate configuration (capacity and refillRate must be finite positive numbers > 0)
  const capacity =
    Number.isFinite(config?.capacity) && config.capacity > 0
      ? config.capacity
      : DEFAULT_TENANT_SOURCE_QUOTA.capacity;

  const refillRate =
    Number.isFinite(config?.refillRatePerMinute) && config.refillRatePerMinute > 0
      ? config.refillRatePerMinute
      : DEFAULT_TENANT_SOURCE_QUOTA.refillRatePerMinute;

  // Validate and parse timestamps safely
  const parsedNow = Date.parse(nowIso);
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const safeNowIso = Number.isFinite(parsedNow) ? nowIso : new Date(nowMs).toISOString();

  const parsedLastRefill = Date.parse(state?.lastRefillAt);
  const lastRefillMs = Number.isFinite(parsedLastRefill) ? parsedLastRefill : nowMs;

  const elapsedMs = Math.max(0, nowMs - lastRefillMs);
  const refillTokens = (elapsedMs / 60_000) * refillRate;
  const currentTokens = Math.min(capacity, safeTokens + refillTokens);

  if (currentTokens >= cost) {
    const remainingTokens = Math.round((currentTokens - cost) * 100) / 100;
    return {
      allowed: true,
      remainingTokens,
      retryAfterSeconds: 0,
      nextState: {
        tokens: remainingTokens,
        lastRefillAt: safeNowIso,
      },
    };
  }

  const deficit = cost - currentTokens;
  // Guaranteed refillRate > 0, strictly avoiding division by zero
  const retryAfterSeconds = Math.max(1, Math.ceil((deficit / refillRate) * 60));
  const remainingTokens = Math.round(currentTokens * 100) / 100;

  return {
    allowed: false,
    remainingTokens,
    retryAfterSeconds,
    nextState: {
      tokens: remainingTokens,
      lastRefillAt: safeNowIso,
    },
  };
}

import {
  canRunSource,
  deduplicateCandidates,
  validateSourceCandidate,
  type DiscoveryQuery,
  type SourceAdapter,
  type SourceCandidate,
} from "@/lib/opportunity-intelligence/sources";

export type DiscoverySourceError = {
  source_id: string;
  code: "source_disallowed" | "source_failed" | "candidate_rejected";
  message: string;
};

export type DiscoveryRunResult = {
  candidates: ReturnType<typeof deduplicateCandidates>;
  attempted_source_ids: string[];
  blocked_source_ids: string[];
  errors: DiscoverySourceError[];
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown source adapter error";
}

/**
 * Coleta candidatos sem fazer efeitos colaterais.
 *
 * O worker persistente poderá chamar esta função dentro do event_log/pg-boss,
 * mas a descoberta em si continua reprocessável: cada adapter é validado antes
 * de rodar, candidatos inválidos não entram no conjunto final e falha de uma
 * fonte não apaga o que veio das demais.
 */
export async function discoverCandidates(input: {
  query: DiscoveryQuery;
  adapters: SourceAdapter[];
}): Promise<DiscoveryRunResult> {
  const rawCandidates: SourceCandidate[] = [];
  const attemptedSourceIds: string[] = [];
  const blockedSourceIds: string[] = [];
  const errors: DiscoverySourceError[] = [];

  for (const adapter of input.adapters) {
    const sourceId = adapter.manifest.source_id;
    const decision = canRunSource(adapter.manifest, input.query.region);

    if (!decision.allowed) {
      blockedSourceIds.push(sourceId);
      errors.push({ source_id: sourceId, code: "source_disallowed", message: decision.reason });
      continue;
    }

    attemptedSourceIds.push(sourceId);

    let discovered: SourceCandidate[];
    try {
      discovered = await adapter.discover(input.query);
    } catch (error) {
      errors.push({ source_id: sourceId, code: "source_failed", message: messageFromError(error) });
      continue;
    }

    for (const candidate of discovered) {
      try {
        rawCandidates.push(validateSourceCandidate(candidate, adapter.manifest));
      } catch (error) {
        errors.push({
          source_id: sourceId,
          code: "candidate_rejected",
          message: messageFromError(error),
        });
      }
    }
  }

  return {
    candidates: deduplicateCandidates(rawCandidates),
    attempted_source_ids: attemptedSourceIds,
    blocked_source_ids: blockedSourceIds,
    errors,
  };
}

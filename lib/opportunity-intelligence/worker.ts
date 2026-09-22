import { randomUUID } from "node:crypto";

import type {
  OpportunityPipelineAssessment,
  OpportunityPipelinePlan,
} from "@/lib/opportunity-intelligence/pipeline";
import { planOpportunityPipeline } from "@/lib/opportunity-intelligence/pipeline";
import {
  discoverCandidates,
  type DiscoveryRunResult,
} from "@/lib/opportunity-intelligence/discovery";
import type {
  DiscoveryQuery,
  DeduplicatedCandidate,
  SourceAdapter,
} from "@/lib/opportunity-intelligence/sources";
import type { PersistPipelinePlanResult } from "@/lib/opportunity-intelligence/write";

export type OpportunityAssessmentError = {
  external_id: string;
  source_id: string;
  message: string;
};

export type OpportunityDiscoveryRunResult = {
  trace_id: string;
  discovery: Pick<DiscoveryRunResult, "attempted_source_ids" | "blocked_source_ids" | "errors">;
  candidates_seen: number;
  assessments_created: number;
  assessment_errors: OpportunityAssessmentError[];
  plan: OpportunityPipelinePlan | null;
  persisted: PersistPipelinePlanResult | null;
};

export type OpportunityAssessmentFactory = (input: {
  candidate: DeduplicatedCandidate;
  trace_id: string;
}) => Promise<OpportunityPipelineAssessment | null>;

export type OpportunityPlanPersister = (
  plan: OpportunityPipelinePlan,
  assessments: OpportunityPipelineAssessment[],
) => Promise<PersistPipelinePlanResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown assessment error";
}

/**
 * Orchestrates one discovery tick without knowing how a source fetches data or
 * how persistence is implemented. Every source and assessment is isolated so
 * one malformed response cannot discard a valid candidate from another source.
 *
 * This is deliberately Copilot-only at the worker boundary. An adapter or LLM
 * may suggest a policy, but no background tick can turn that into autonomous
 * outbound permission.
 */
export async function runOpportunityDiscovery(input: {
  query: DiscoveryQuery;
  adapters: SourceAdapter[];
  assessCandidate: OpportunityAssessmentFactory;
  persistPlan: OpportunityPlanPersister;
  trace_id?: string;
}): Promise<OpportunityDiscoveryRunResult> {
  const traceId = input.trace_id ?? randomUUID();
  const discovery = await discoverCandidates({ query: input.query, adapters: input.adapters });
  const assessments: OpportunityPipelineAssessment[] = [];
  const assessmentErrors: OpportunityAssessmentError[] = [];

  for (const candidate of discovery.candidates) {
    try {
      const assessment = await input.assessCandidate({ candidate, trace_id: traceId });
      if (!assessment) continue;

      const allowedSourceIds = new Set([candidate.source_id, ...candidate.duplicate_source_ids]);
      const foreignEvidence = assessment.evidence
        .map((evidence) => evidence.source_id)
        .filter((sourceId) => !allowedSourceIds.has(sourceId));
      if (foreignEvidence.length > 0) {
        throw new Error(
          `assessment evidence source is not part of the discovered candidate: ${[...new Set(foreignEvidence)].join(", ")}`,
        );
      }

      assessments.push({
        ...assessment,
        tenant_policy: { require_human_approval: true },
      });
    } catch (error) {
      assessmentErrors.push({
        external_id: candidate.external_id,
        source_id: candidate.source_id,
        message: errorMessage(error),
      });
    }
  }

  if (assessments.length === 0) {
    return {
      trace_id: traceId,
      discovery: {
        attempted_source_ids: discovery.attempted_source_ids,
        blocked_source_ids: discovery.blocked_source_ids,
        errors: discovery.errors,
      },
      candidates_seen: discovery.candidates.length,
      assessments_created: 0,
      assessment_errors: assessmentErrors,
      plan: null,
      persisted: null,
    };
  }

  const plan = planOpportunityPipeline({
    trace_id: traceId,
    schema_version: 1,
    organization_id: input.query.organization_id,
    assessments,
  });
  const persisted = await input.persistPlan(plan, assessments);

  return {
    trace_id: traceId,
    discovery: {
      attempted_source_ids: discovery.attempted_source_ids,
      blocked_source_ids: discovery.blocked_source_ids,
      errors: discovery.errors,
    },
    candidates_seen: discovery.candidates.length,
    assessments_created: assessments.length,
    assessment_errors: assessmentErrors,
    plan,
    persisted,
  };
}

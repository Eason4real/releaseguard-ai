import { getPendingEvidence } from "./hypothesis-invariants";
import type {
  InvestigationDecision,
  InvestigationPlanner,
  PlannerContext,
  PlannerDecisionValidationObservation,
  PlannerModelCallObservation,
} from "./planner";
import { PlannerDecisionSemanticError } from "./planner-decision-semantics";
import { PlannerDecisionValidationError } from "./llm-planner";
import type { InvestigationAggregate } from "./types";
import {
  buildEvidencePacketV2,
  evaluateEvidenceReadinessV2,
  type EvidencePacketV2,
  type EvidenceReadinessV2Decision,
} from "./evidence-packet-v2";

export type EvidenceReadinessStatus =
  | "READY_TO_SYNTHESIZE"
  | "NEEDS_MORE_EVIDENCE"
  | "UNRESOLVABLE_WITH_AVAILABLE_TOOLS";

export type EvidenceReadinessDecision = {
  status: EvidenceReadinessStatus;
  reasons: string[];
  missingCategories: string[];
  categoriesPresent: string[];
  independentCurrentSources: number;
  supportedHypothesisIds: string[];
};

export type EvidencePacket = {
  schemaVersion: "releaseguard-evidence-packet-v1";
  investigation: {
    runId: string;
    question: string;
    incidentId: string;
    release: { id: string; version: string; platform: string } | null;
    riskEvent: { metricKey: string; firstBreachedAt: string; lastBreachedAt: string } | null;
  };
  hypotheses: Array<{
    id: string;
    statement: string;
    status: string;
    confidence: string;
    supportScore: number;
    contradictionScore: number;
  }>;
  evidence: Array<{
    id: string;
    category: string;
    statement: string;
    source: string;
    strength: string;
    provenance: string;
    collectedAt: string;
    relations: Array<{
      hypothesisId: string;
      relation: string;
      explanation: string;
    }>;
  }>;
  readiness: EvidenceReadinessDecision;
};

export type InvestigationSynthesizer = {
  readonly type: "LLM" | "DETERMINISTIC";
  synthesize(context: PlannerContext & {
    evidencePacket: EvidencePacket | EvidencePacketV2;
    readiness: EvidenceReadinessDecision | EvidenceReadinessV2Decision;
  }): Promise<Extract<InvestigationDecision, { type: "FINALIZE" | "STOP_INCONCLUSIVE" }>>;
  drainModelCallObservations?(): PlannerModelCallObservation[];
  drainDecisionValidationObservations?(): PlannerDecisionValidationObservation[];
};

const isStructuredDecisionFailure = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  const name = String((error as { name?: unknown }).name ?? "");
  const message = String((error as { message?: unknown }).message ?? "");
  return ["PlannerDecisionValidationError", "PlannerDecisionSemanticError"].includes(name)
    || /Planner|JSON|rationale|字段|缺失|未通过|Hypothesis|Evidence|Diagnosis/i.test(message);
};

const CURRENT_INCIDENT_CATEGORIES = new Set([
  "RELEASE_CHANGE",
  "PRODUCT_METRIC",
  "SEGMENT_METRIC",
  "USER_FEEDBACK",
]);

export function evaluateEvidenceReadiness(
  aggregate: InvestigationAggregate,
  remainingToolCalls: number,
): EvidenceReadinessDecision {
  const pending = new Set(getPendingEvidence(aggregate).map((item) => item.id));
  const assessedEvidence = aggregate.evidence.filter((item) => !pending.has(item.id));
  const categoriesPresent = [...new Set(assessedEvidence.map((item) => item.category))].sort();
  const categorySet = new Set(categoriesPresent);
  const currentEvidence = assessedEvidence.filter((item) =>
    CURRENT_INCIDENT_CATEGORIES.has(item.category));
  const independentCurrentSources = new Set(currentEvidence.map((item) =>
    `${item.category}:${item.toolResultId}`)).size;
  const supportedHypothesisIds = aggregate.hypotheses.filter((item) =>
    ["SUPPORTED", "CONFIRMED"].includes(item.status)
    && ["MEDIUM", "HIGH"].includes(item.confidence)).map((item) => item.id).sort();
  const missingCategories: string[] = [];
  if (!categorySet.has("RELEASE_CHANGE")) missingCategories.push("RELEASE_CONTEXT");
  if (!categorySet.has("PRODUCT_METRIC") && !categorySet.has("SEGMENT_METRIC")) {
    missingCategories.push("CURRENT_IMPACT");
  }
  const reasons: string[] = [];
  if (aggregate.hypotheses.length === 0) reasons.push("NO_COMPETING_HYPOTHESES");
  if (pending.size > 0) reasons.push("PENDING_EVIDENCE_ASSESSMENT");
  if (independentCurrentSources < 2) reasons.push("INSUFFICIENT_INDEPENDENT_CURRENT_SOURCES");
  if (supportedHypothesisIds.length === 0) reasons.push("NO_SUPPORTED_LEADING_HYPOTHESIS");
  if (missingCategories.length > 0) reasons.push("MISSING_REQUIRED_EVIDENCE_CATEGORIES");

  if (reasons.length === 0) {
    return {
      status: "READY_TO_SYNTHESIZE",
      reasons: ["PERSISTED_EVIDENCE_PACKET_READY"],
      missingCategories,
      categoriesPresent,
      independentCurrentSources,
      supportedHypothesisIds,
    };
  }
  return {
    status: remainingToolCalls > 0
      ? "NEEDS_MORE_EVIDENCE"
      : "UNRESOLVABLE_WITH_AVAILABLE_TOOLS",
    reasons,
    missingCategories,
    categoriesPresent,
    independentCurrentSources,
    supportedHypothesisIds,
  };
}

export function buildEvidencePacket(
  aggregate: InvestigationAggregate,
  readiness: EvidenceReadinessDecision,
): EvidencePacket {
  const linksByEvidence = new Map<string, typeof aggregate.hypothesisEvidenceLinks>();
  for (const link of aggregate.hypothesisEvidenceLinks) {
    const links = linksByEvidence.get(link.evidenceId) ?? [];
    links.push(link);
    linksByEvidence.set(link.evidenceId, links);
  }
  return {
    schemaVersion: "releaseguard-evidence-packet-v1",
    investigation: {
      runId: aggregate.run.id,
      question: aggregate.run.question,
      incidentId: aggregate.run.incidentId,
      release: aggregate.release ? {
        id: aggregate.release.id,
        version: aggregate.release.version,
        platform: aggregate.release.platform,
      } : null,
      riskEvent: aggregate.riskEvent ? {
        metricKey: aggregate.riskEvent.metricKey,
        firstBreachedAt: aggregate.riskEvent.firstBreachedAt,
        lastBreachedAt: aggregate.riskEvent.lastBreachedAt,
      } : null,
    },
    hypotheses: aggregate.hypotheses.map((item) => ({
      id: item.id,
      statement: item.statement,
      status: item.status,
      confidence: item.confidence,
      supportScore: item.supportScore,
      contradictionScore: item.contradictionScore,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    evidence: aggregate.evidence.map((item) => ({
      id: item.id,
      category: item.category,
      statement: item.statement,
      source: item.source,
      strength: item.strength,
      provenance: item.provenance,
      collectedAt: item.collectedAt,
      relations: (linksByEvidence.get(item.id) ?? []).map((link) => ({
        hypothesisId: link.hypothesisId,
        relation: link.relation,
        explanation: link.explanation,
      })).sort((left, right) => left.hypothesisId.localeCompare(right.hypothesisId)),
    })).sort((left, right) => left.category.localeCompare(right.category)
      || left.id.localeCompare(right.id)),
    readiness,
  };
}

export class StagedInvestigationPlanner implements InvestigationPlanner {
  readonly type = "LLM" as const;

  constructor(
    private readonly collector: InvestigationPlanner,
    private readonly synthesizer: InvestigationSynthesizer,
    private readonly options: { packetVersion?: "V1" | "V2" } = {},
  ) {}

  private readiness(context: PlannerContext) {
    return this.options.packetVersion === "V2"
      ? evaluateEvidenceReadinessV2(context.aggregate, context.remainingToolCalls)
      : evaluateEvidenceReadiness(context.aggregate, context.remainingToolCalls);
  }

  private packet(
    aggregate: InvestigationAggregate,
    readiness: EvidenceReadinessDecision | EvidenceReadinessV2Decision,
  ) {
    return this.options.packetVersion === "V2"
      ? buildEvidencePacketV2(aggregate, readiness as EvidenceReadinessV2Decision)
      : buildEvidencePacket(aggregate, readiness as EvidenceReadinessDecision);
  }

  drainModelCallObservations() {
    return [
      ...(this.collector.drainModelCallObservations?.() ?? []),
      ...(this.synthesizer.drainModelCallObservations?.() ?? []),
    ];
  }

  drainDecisionValidationObservations() {
    return [
      ...(this.collector.drainDecisionValidationObservations?.() ?? []),
      ...(this.synthesizer.drainDecisionValidationObservations?.() ?? []),
    ];
  }

  async plan(context: PlannerContext): Promise<InvestigationDecision> {
    const readiness = this.readiness(context);
    const canSynthesize = getPendingEvidence(context.aggregate).length === 0
      && readiness.status !== "NEEDS_MORE_EVIDENCE"
      && readiness.status !== "NEEDS_COLLECTION";
    if (canSynthesize) {
      try {
        return await this.synthesizer.synthesize({
          ...context,
          evidencePacket: this.packet(context.aggregate, readiness),
          readiness,
        });
      } catch (error) {
        if (isStructuredDecisionFailure(error)) {
          return {
            type: "STOP_INCONCLUSIVE",
            reasonCode: "INSUFFICIENT_EVIDENCE",
            reason: "综合阶段的结构化响应未通过有界校验；保留已收集 Evidence，需人工复核或重试。",
            rationale: "服务端拒绝未经验证的根因结论，安全停止调查。",
          };
        }
        throw error;
      }
    }

    let collectionDecision: InvestigationDecision;
    try {
      collectionDecision = await this.collector.plan({
        ...context,
        runtimeGuidance: {
          ...context.runtimeGuidance,
          stagedArchitecture: {
            phase: "EVIDENCE_COLLECTION",
            readiness,
            terminalDecisionsOwnedBy: "SYNTHESIZER",
          },
        },
      });
    } catch (error) {
      if (isStructuredDecisionFailure(error)) {
        return {
          type: "STOP_INCONCLUSIVE",
          reasonCode: "INSUFFICIENT_EVIDENCE",
          reason: "证据收集阶段的结构化响应未通过有界校验；保留已收集 Evidence，需人工复核或重试。",
          rationale: "服务端拒绝未经验证的下一步，安全停止调查。",
        };
      }
      throw error;
    }
    if (collectionDecision.type !== "FINALIZE"
      && collectionDecision.type !== "STOP_INCONCLUSIVE") return collectionDecision;

    try {
      return await this.synthesizer.synthesize({
        ...context,
        evidencePacket: this.packet(context.aggregate, readiness),
        readiness,
      });
    } catch (error) {
      if (isStructuredDecisionFailure(error)) {
        return {
          type: "STOP_INCONCLUSIVE",
          reasonCode: "INSUFFICIENT_EVIDENCE",
          reason: "综合阶段的结构化响应未通过有界校验；保留已收集 Evidence，需人工复核或重试。",
          rationale: "服务端拒绝未经验证的根因结论，安全停止调查。",
        };
      }
      throw error;
    }
  }
}

import type { MetricFilters, Release, RiskEvent } from "../../../../lib/analytics/types";
import type {
  BenchmarkCaseCategory,
  RootCauseEvaluationRubric,
} from "../../types";
import type {
  DatasetCaseEntry,
  DatasetEvidenceObservation,
  DatasetProvenance,
  GovernedBenchmarkCaseFixture,
} from "../types";

type SourceKind = GovernedBenchmarkCaseFixture["benchmarkCase"]["dataSources"][number]["kind"];

export type DevObservationSpec = {
  sourceKey: string;
  sourceKind: SourceKind;
  toolName: string;
  role: DatasetEvidenceObservation["role"];
  payload: unknown;
  observationScope?: DatasetEvidenceObservation["observationScope"];
};

export type DevCaseSpec = {
  number: number;
  title: string;
  question: string;
  symptom: string;
  category: BenchmarkCaseCategory;
  templateFamily: string;
  provenance: DatasetProvenance;
  metricKey: string;
  metricDirection?: "DOWN" | "UP";
  filters: MetricFilters;
  observedValue: number;
  baselineValue: number;
  release?: {
    version: string;
    platform: string;
    rolloutStatus: string;
    rolloutPercentage: number;
    featureFlags: string[];
    changedModules: string[];
  } | null;
  observations: DevObservationSpec[];
  requiredObservationIndexes: number[];
  supportingObservationIndexes: number[];
  distractorObservationIndexes: number[];
  canonicalRootCause: string;
  acceptableAliases: string[];
  rootCauseEvaluation?: Partial<RootCauseEvaluationRubric>;
  semanticDifficulty: {
    plausibleHypotheses: 0 | 1 | 2;
    causalDirectness: 0 | 1 | 2;
    temporalCorrelationTrap: 0 | 1 | 2;
    evidenceCompleteness: 0 | 1 | 2;
  };
  reviewNotes: [string, string, string];
};

export type AuthoredDevCase = {
  entry: DatasetCaseEntry;
  fixture: GovernedBenchmarkCaseFixture;
  symptom: string;
};

const pad = (value: number) => String(value).padStart(3, "0");
const difficultyForScore = (score: number) => score <= 3
  ? "EASY" as const
  : score <= 7 ? "MEDIUM" as const : "HARD" as const;

const caseTimestamp = (number: number, hour: number) => new Date(Date.UTC(
  2031, 0, number - 200, hour, 0, 0,
)).toISOString();

const makeRelease = (spec: DevCaseSpec): Release | null | undefined => {
  if (spec.release === undefined) return undefined;
  if (spec.release === null) return null;
  return {
    id: `REL-${pad(spec.number)}`,
    version: spec.release.version,
    platform: spec.release.platform,
    releasedAt: caseTimestamp(spec.number, 9),
    rolloutStatus: spec.release.rolloutStatus,
    rolloutPercentage: spec.release.rolloutPercentage,
    featureFlags: [...spec.release.featureFlags],
    changedModules: [...spec.release.changedModules],
    provenance: "governed_dev_fixture",
    createdAt: caseTimestamp(spec.number, 8),
  };
};

const makeRiskEvent = (spec: DevCaseSpec, release: Release | null | undefined): RiskEvent => ({
  id: `RISK-${pad(spec.number)}`,
  correlatedReleaseId: release?.id ?? null,
  metricKey: spec.metricKey,
  status: "OPEN",
  direction: spec.metricDirection ?? "DOWN",
  filters: { ...spec.filters },
  segmentSignature: Object.entries(spec.filters).sort(([left], [right]) =>
    left.localeCompare(right)).map(([key, value]) => `${key}=${value}`).join("|") || "all",
  detectedAt: caseTimestamp(spec.number, 11),
  firstBreachedAt: caseTimestamp(spec.number, 10),
  lastBreachedAt: caseTimestamp(spec.number, 11),
  observedValue: spec.observedValue,
  baselineValue: spec.baselineValue,
  absoluteDeviation: spec.observedValue - spec.baselineValue,
  relativeDeviation: spec.baselineValue === 0
    ? 0
    : (spec.observedValue - spec.baselineValue) / spec.baselineValue,
  sampleSize: 1_200,
  thresholdPct: 0.1,
  minSampleSize: 500,
  requiredConsecutiveBuckets: 3,
  triggerBucketIds: [`MB-${pad(spec.number)}-001`, `MB-${pad(spec.number)}-002`,
    `MB-${pad(spec.number)}-003`],
  baselineMethod: "RECENT_MEDIAN",
  baselinePointCount: 12,
  triggerSignature: `risk:${pad(spec.number)}`,
  provenance: "governed_dev_fixture",
  createdAt: caseTimestamp(spec.number, 11),
  updatedAt: caseTimestamp(spec.number, 11),
});

export function authorDevCase(spec: DevCaseSpec): AuthoredDevCase {
  const block = (spec.number - 200) * 20;
  const sourceKeys = [...new Set(spec.observations.map((item) => item.sourceKey))];
  const sourceIdByKey = new Map(sourceKeys.map((key, index) =>
    [key, `SRC-${pad(block + index + 1)}`]));
  const evidenceIdByIndex = spec.observations.map((_, index) => `EV-${pad(block + 10 + index)}`);
  const evidence: DatasetEvidenceObservation[] = spec.observations.map((item, index) => ({
    evidenceId: evidenceIdByIndex[index],
    sourceId: sourceIdByKey.get(item.sourceKey)!,
    toolName: item.toolName,
    observationScope: item.observationScope ?? "CURRENT_INCIDENT",
    role: item.role,
    payload: structuredClone(item.payload),
  }));
  const dataSources = sourceKeys.map((sourceKey) => {
    const sourceId = sourceIdByKey.get(sourceKey)!;
    const sourceObservation = spec.observations.find((item) => item.sourceKey === sourceKey)!;
    return {
      sourceId,
      kind: sourceObservation.sourceKind,
      fixtureRef: `fixture://${sourceId}`,
      evidenceIds: evidence.filter((item) => item.sourceId === sourceId)
        .map((item) => item.evidenceId),
    };
  });
  const supportingEvidenceIds = spec.supportingObservationIndexes.map((index) =>
    evidenceIdByIndex[index]);
  const requiredEvidenceIds = spec.requiredObservationIndexes.map((index) =>
    evidenceIdByIndex[index]);
  const distractorEvidenceIds = spec.distractorObservationIndexes.map((index) =>
    evidenceIdByIndex[index]);
  const supportingSourceCount = new Set(spec.supportingObservationIndexes.map((index) =>
    spec.observations[index].sourceKey)).size;
  const distractorCount = distractorEvidenceIds.length <= 1
    ? 0 as const
    : distractorEvidenceIds.length <= 3 ? 1 as const : 2 as const;
  const sourceCount = supportingSourceCount <= 1
    ? 0 as const
    : supportingSourceCount === 2 ? 1 as const : 2 as const;
  const difficultyDimensions = {
    distractorCount,
    sourceCount,
    ...spec.semanticDifficulty,
  };
  const difficultyScore = Object.values(difficultyDimensions)
    .reduce<number>((sum, value) => sum + value, 0);
  const difficulty = difficultyForScore(difficultyScore);
  const release = makeRelease(spec);
  const caseId = `CASE-${pad(spec.number)}`;
  const fixtureRef = `benchmark-fixture://FX-${pad(spec.number)}`;
  const groundTruth = {
    canonicalRootCauseId: `RC-${pad(spec.number)}`,
    canonicalRootCause: spec.canonicalRootCause,
    acceptableAliases: [...spec.acceptableAliases],
    requiredEvidenceIds,
    supportingEvidenceIds,
    distractorEvidenceIds,
    rootCauseEvaluation: {
      expectedAnswerMode: spec.category === "insufficient_evidence"
        ? "ABSTAIN" as const
        : "CAUSAL" as const,
      requiredConceptGroups: [],
      optionalConcepts: [],
      forbiddenConcepts: [],
      uncertaintyPolicy: spec.category === "insufficient_evidence"
        ? "REQUIRE_ABSTENTION" as const
        : "NOT_APPLICABLE" as const,
      specificityPolicy: "ALLOW_MORE_SPECIFIC_IF_CONSISTENT" as const,
      ...structuredClone(spec.rootCauseEvaluation ?? {}),
    },
  };
  const requiredTools = [...new Set(spec.supportingObservationIndexes.map((index) =>
    spec.observations[index].toolName))].sort();

  return {
    symptom: spec.symptom,
    entry: {
      schemaVersion: "1",
      caseId,
      split: "DEV",
      category: spec.category,
      difficulty,
      difficultyScore,
      difficultyDimensions,
      templateFamily: spec.templateFamily,
      provenance: structuredClone(spec.provenance),
      fixtureRef,
      requiredTools,
      manualReview: {
        groundTruthSemantics: "APPROVED",
        toolSolvability: "APPROVED",
        splitSimilarity: "APPROVED",
        notes: [...spec.reviewNotes],
      },
      enabled: true,
    },
    fixture: {
      schemaVersion: "1",
      fixtureRef,
      benchmarkCase: {
        caseId,
        title: spec.title,
        category: spec.category,
        difficulty: difficulty.toLocaleLowerCase("en-US") as "easy" | "medium" | "hard",
        input: {
          incidentId: `INC-${pad(spec.number)}`,
          question: spec.question,
          riskEvent: makeRiskEvent(spec, release),
          ...(release !== undefined ? { release } : {}),
        },
        dataSources,
        groundTruth,
      },
      evidence,
      evidenceGraph: {
        edges: requiredEvidenceIds.slice(1).map((evidenceId, index) => ({
          fromEvidenceId: requiredEvidenceIds[index],
          toEvidenceId: evidenceId,
          relation: "SUPPORTS" as const,
        })),
      },
      fixtureData: {
        datasetStage: "GOVERNED_DEV",
        toolResults: evidence.map((item) => ({
          sourceRef: `fixture://${item.sourceId}`,
          toolName: item.toolName,
          status: "SUCCESS",
          output: structuredClone(item.payload),
        })),
      },
    },
  };
}

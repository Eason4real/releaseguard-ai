import type {
  BenchmarkCaseCategory,
  BenchmarkDifficulty,
  InvestigationBenchmarkCase,
} from "../types";

export const DATASET_SCHEMA_VERSION = "1" as const;
export const DATASET_SPLITS = ["DEV", "HOLDOUT"] as const;
export const DATASET_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export const DATASET_SOURCE_TYPES = [
  "repository_native",
  "adapted_public_pattern",
  "synthetic",
] as const;

export type DatasetSplit = (typeof DATASET_SPLITS)[number];
export type DatasetDifficulty = (typeof DATASET_DIFFICULTIES)[number];
export type DatasetSourceType = (typeof DATASET_SOURCE_TYPES)[number];

export type DatasetProvenance = {
  sourceType: DatasetSourceType;
  description: string;
  sourceReference?: string;
  adaptationNotes?: string;
};

export type DifficultyDimensions = {
  distractorCount: 0 | 1 | 2;
  plausibleHypotheses: 0 | 1 | 2;
  sourceCount: 0 | 1 | 2;
  causalDirectness: 0 | 1 | 2;
  temporalCorrelationTrap: 0 | 1 | 2;
  evidenceCompleteness: 0 | 1 | 2;
};

export type DatasetManualReview = {
  groundTruthSemantics: "APPROVED" | "REQUIRED";
  toolSolvability: "APPROVED" | "REQUIRED";
  splitSimilarity: "APPROVED" | "REQUIRED";
  notes: string[];
};

export type DatasetCaseEntry = {
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  caseId: string;
  split: DatasetSplit;
  category: BenchmarkCaseCategory;
  difficulty: DatasetDifficulty;
  difficultyScore: number;
  difficultyDimensions: DifficultyDimensions;
  templateFamily: string;
  provenance: DatasetProvenance;
  fixtureRef: string;
  requiredTools: string[];
  manualReview: DatasetManualReview;
  enabled: boolean;
};

export type InvestigationBenchmarkDatasetManifest = {
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  datasetId: string;
  purpose: "GOVERNED_BENCHMARK" | "GOVERNED_DEV" | "TEST_ONLY";
  version: string;
  evaluationContractVersion: string;
  createdAt: string;
  updatedAt: string;
  expectedDatasetHash: string | null;
  caseEntries: DatasetCaseEntry[];
};

export type DatasetEvidenceObservation = {
  evidenceId: string;
  sourceId: string;
  toolName: string;
  observationScope: "CURRENT_INCIDENT" | "HISTORICAL";
  role: "CAUSAL" | "SYMPTOM" | "CONTEXT" | "NEGATIVE" | "DISTRACTOR";
  payload: unknown;
};

export type DatasetEvidenceGraph = {
  edges: Array<{
    fromEvidenceId: string;
    toEvidenceId: string;
    relation: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
  }>;
};

export type GovernedBenchmarkCaseFixture = {
  schemaVersion: typeof DATASET_SCHEMA_VERSION;
  fixtureRef: string;
  benchmarkCase: InvestigationBenchmarkCase;
  evidence: DatasetEvidenceObservation[];
  evidenceGraph: DatasetEvidenceGraph;
  fixtureData: unknown;
};

export type InvestigationBenchmarkDatasetDefinition = {
  manifest: InvestigationBenchmarkDatasetManifest;
  fixtures: GovernedBenchmarkCaseFixture[];
};

export type DatasetGateStatus = "PASS" | "FAIL" | "WARN" | "MANUAL_REVIEW";

export type DatasetValidationIssue = {
  status: Exclude<DatasetGateStatus, "PASS">;
  code: string;
  reason: string;
  caseId?: string;
};

export type DatasetGateName =
  | "manifestIntegrity"
  | "coverage"
  | "categoryBalance"
  | "difficultyBalance"
  | "groundTruthIntegrity"
  | "toolSolvability"
  | "duplicateDetection"
  | "splitLeakage"
  | "determinism"
  | "provenance"
  | "datasetHash";

export type DatasetGateReport = {
  status: DatasetGateStatus;
  issues: DatasetValidationIssue[];
};

export type InvestigationBenchmarkDatasetValidationReport = {
  status: DatasetGateStatus;
  valid: boolean;
  datasetId: string;
  datasetVersion: string;
  calculatedDatasetHash: string;
  expectedDatasetHash: string | null;
  gates: Record<DatasetGateName, DatasetGateReport>;
};

export const toDatasetDifficulty = (difficulty: BenchmarkDifficulty): DatasetDifficulty =>
  difficulty.toUpperCase() as DatasetDifficulty;

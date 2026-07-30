import { modelToolDefinitions } from "../../../lib/investigation/tools";
import { canonicalJson, sha256 } from "../../../lib/retrieval/public-incidents/normalize";
import { deriveBenchmarkExecutionRequest } from "../execution-input";
import { BENCHMARK_CASE_CATEGORIES } from "../types";
import {
  calculateInvestigationBenchmarkDatasetHash,
} from "./hash";
import {
  DATASET_DIFFICULTIES,
  DATASET_SCHEMA_VERSION,
  DATASET_SOURCE_TYPES,
  DATASET_SPLITS,
  toDatasetDifficulty,
  type DatasetCaseEntry,
  type DatasetDifficulty,
  type DatasetGateName,
  type DatasetGateReport,
  type DatasetGateStatus,
  type DatasetValidationIssue,
  type GovernedBenchmarkCaseFixture,
  type InvestigationBenchmarkDatasetDefinition,
  type InvestigationBenchmarkDatasetValidationReport,
} from "./types";

const FORMAL_CATEGORY_COUNTS = {
  release_regression: { DEV: 5, HOLDOUT: 3 },
  configuration: { DEV: 4, HOLDOUT: 3 },
  upstream_dependency: { DEV: 3, HOLDOUT: 2 },
  user_feedback: { DEV: 3, HOLDOUT: 2 },
  unknown: { DEV: 3, HOLDOUT: 2 },
  insufficient_evidence: { DEV: 4, HOLDOUT: 2 },
} as const;

const FORMAL_DIFFICULTY_COUNTS: Record<DatasetDifficulty, { DEV: number; HOLDOUT: number }> = {
  EASY: { DEV: 7, HOLDOUT: 3 },
  MEDIUM: { DEV: 10, HOLDOUT: 7 },
  HARD: { DEV: 5, HOLDOUT: 4 },
};

const TOOL_SOURCE_KIND: Record<string, string> = {
  get_release: "release",
  query_metric: "analytics",
  segment_metric: "analytics",
  search_user_feedback: "feedback",
  search_similar_incidents: "historical_incident",
};

const RESERVED_POSITIVE_CATEGORIES = new Set(["database", "infrastructure"]);
const STATUS_RANK: Record<DatasetGateStatus, number> = {
  PASS: 0,
  WARN: 1,
  MANUAL_REVIEW: 2,
  FAIL: 3,
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};
const duplicates = (values: string[]) => {
  const seen = new Set<string>();
  const result = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) result.add(value);
    seen.add(value);
  }
  return [...result].sort();
};
const sameStringSet = (left: string[], right: string[]) => {
  const sortedLeft = [...new Set(left)].sort();
  const sortedRight = [...new Set(right)].sort();
  return canonicalJson(sortedLeft) === canonicalJson(sortedRight);
};
const normalizeAnswer = (value: string) => value
  .normalize("NFKC")
  .toLocaleLowerCase("en-US")
  .replace(/[\p{P}\p{S}\s]+/gu, "");

const blankGate = (): DatasetGateReport => ({ status: "PASS", issues: [] });
const blankGates = (): Record<DatasetGateName, DatasetGateReport> => ({
  manifestIntegrity: blankGate(),
  coverage: blankGate(),
  categoryBalance: blankGate(),
  difficultyBalance: blankGate(),
  groundTruthIntegrity: blankGate(),
  toolSolvability: blankGate(),
  duplicateDetection: blankGate(),
  splitLeakage: blankGate(),
  determinism: blankGate(),
  provenance: blankGate(),
  datasetHash: blankGate(),
});

const addIssue = (
  gates: Record<DatasetGateName, DatasetGateReport>,
  gate: DatasetGateName,
  issue: DatasetValidationIssue,
) => {
  gates[gate].issues.push(issue);
  if (STATUS_RANK[issue.status] > STATUS_RANK[gates[gate].status]) {
    gates[gate].status = issue.status;
  }
};

const validIsoDate = (value: unknown) => typeof value === "string"
  && Number.isFinite(Date.parse(value));

const difficultyScore = (entry: DatasetCaseEntry) => Object.values(
  record(entry.difficultyDimensions),
).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);

const difficultyForScore = (score: number): DatasetDifficulty | null => {
  if (score >= 0 && score <= 3) return "EASY";
  if (score >= 4 && score <= 7) return "MEDIUM";
  if (score >= 8 && score <= 12) return "HARD";
  return null;
};

const shape = (value: unknown): unknown => {
  if (Array.isArray(value)) return { type: "array", items: value.map(shape) };
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, shape(item)]));
  }
  if (value === null) return "null";
  return typeof value;
};

const exactFixtureFingerprint = (fixture: GovernedBenchmarkCaseFixture) => sha256(canonicalJson({
  input: fixture.benchmarkCase.input,
  dataSources: fixture.benchmarkCase.dataSources.map((source) => ({
    kind: source.kind,
    evidenceCount: source.evidenceIds.length,
  })),
  evidence: fixture.evidence.map((item) => ({
    toolName: item.toolName,
    observationScope: item.observationScope,
    role: item.role,
    payload: item.payload,
  })),
  evidenceGraph: fixture.evidenceGraph,
  fixtureData: fixture.fixtureData,
}));

const structuralFixtureFingerprint = (fixture: GovernedBenchmarkCaseFixture) => {
  const groundTruth = fixture.benchmarkCase.groundTruth;
  const labels = new Map<string, string>();
  groundTruth.supportingEvidenceIds.forEach((id) => labels.set(id, "SUPPORTING"));
  groundTruth.requiredEvidenceIds.forEach((id) => labels.set(id, "REQUIRED"));
  groundTruth.distractorEvidenceIds.forEach((id) => labels.set(id, "DISTRACTOR"));
  const positions = new Map(fixture.evidence.map((item, index) => [item.evidenceId, index]));
  return sha256(canonicalJson({
    inputShape: shape(fixture.benchmarkCase.input),
    dataSources: fixture.benchmarkCase.dataSources.map((source) => ({
      kind: source.kind,
      evidenceCount: source.evidenceIds.length,
    })),
    evidence: fixture.evidence.map((item) => ({
      toolName: item.toolName,
      observationScope: item.observationScope,
      role: item.role,
      groundTruthRole: labels.get(item.evidenceId) ?? "UNLABELED",
      payloadShape: shape(item.payload),
    })),
    edges: fixture.evidenceGraph.edges.map((edge) => ({
      from: positions.get(edge.fromEvidenceId) ?? -1,
      to: positions.get(edge.toEvidenceId) ?? -1,
      relation: edge.relation,
    })),
    fixtureDataShape: shape(fixture.fixtureData),
  }));
};

const validateManifestEntry = (
  entry: DatasetCaseEntry,
  fixture: GovernedBenchmarkCaseFixture | undefined,
  gates: Record<DatasetGateName, DatasetGateReport>,
) => {
  const caseId = text(entry.caseId) || undefined;
  if (entry.schemaVersion !== DATASET_SCHEMA_VERSION) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_CASE_SCHEMA_VERSION",
      reason: "Case entry schemaVersion must be 1.", caseId });
  }
  if (!(DATASET_SPLITS as readonly unknown[]).includes(entry.split)) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_SPLIT",
      reason: "Case split must be DEV or HOLDOUT.", caseId });
  }
  if (!(BENCHMARK_CASE_CATEGORIES as readonly unknown[]).includes(entry.category)) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_CATEGORY",
      reason: "Case category is not supported by BenchmarkCaseCategory.", caseId });
  }
  if (!(DATASET_DIFFICULTIES as readonly unknown[]).includes(entry.difficulty)) {
    addIssue(gates, "difficultyBalance", { status: "FAIL", code: "INVALID_DIFFICULTY",
      reason: "Difficulty must be EASY, MEDIUM, or HARD.", caseId });
  }
  if (!/^TPL-\d{3,}$/.test(text(entry.templateFamily))) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "NON_OPAQUE_TEMPLATE_FAMILY",
      reason: "templateFamily must use an opaque TPL-NNN identifier.", caseId });
  }
  if (!/^(benchmark|test-only)-fixture:\/\/FX-\d{3,}$/.test(text(entry.fixtureRef))) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_FIXTURE_REFERENCE",
      reason: "fixtureRef must be a stable opaque benchmark fixture reference.", caseId });
  }
  if (!fixture) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "MISSING_FIXTURE",
      reason: `Fixture ${String(entry.fixtureRef)} does not resolve.`, caseId });
  } else {
    if (fixture.benchmarkCase.caseId !== entry.caseId) {
      addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "CASE_FIXTURE_ID_MISMATCH",
        reason: "Manifest caseId does not match the referenced fixture caseId.", caseId });
    }
    if (fixture.benchmarkCase.category !== entry.category) {
      addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "CASE_CATEGORY_MISMATCH",
        reason: "Manifest category does not match the fixture case category.", caseId });
    }
    if (toDatasetDifficulty(fixture.benchmarkCase.difficulty) !== entry.difficulty) {
      addIssue(gates, "difficultyBalance", { status: "FAIL", code: "CASE_DIFFICULTY_MISMATCH",
        reason: "Manifest difficulty does not match the fixture case difficulty.", caseId });
    }
  }

  const dimensions = Object.values(record(entry.difficultyDimensions));
  if (dimensions.length !== 6 || dimensions.some((value) =>
    !Number.isInteger(value) || (value as number) < 0 || (value as number) > 2)) {
    addIssue(gates, "difficultyBalance", { status: "FAIL", code: "INVALID_DIFFICULTY_DIMENSIONS",
      reason: "All six difficulty dimensions must be integers from 0 to 2.", caseId });
  } else {
    const calculated = difficultyScore(entry);
    const expectedDifficulty = difficultyForScore(calculated);
    if (entry.difficultyScore !== calculated || entry.difficulty !== expectedDifficulty) {
      addIssue(gates, "difficultyBalance", { status: "FAIL", code: "DIFFICULTY_SCORE_MISMATCH",
        reason: "difficultyScore and level must match the six-dimension rubric.", caseId });
    }
    const dimension = entry.difficultyDimensions;
    if (entry.difficulty === "EASY" && Object.values(dimension).some((value) => value === 2)) {
      addIssue(gates, "difficultyBalance", { status: "FAIL", code: "EASY_STRUCTURE_MISMATCH",
        reason: "EASY cases cannot score 2 in any dimension.", caseId });
    }
    if (entry.difficulty === "MEDIUM") {
      const elevated = Object.values(dimension).filter((value) => value >= 1).length;
      if (elevated < 2 || (dimension.sourceCount < 1 && dimension.plausibleHypotheses < 1)) {
        addIssue(gates, "difficultyBalance", { status: "FAIL", code: "MEDIUM_STRUCTURE_MISMATCH",
          reason: "MEDIUM cases require two elevated dimensions and multiple sources or hypotheses.", caseId });
      }
    }
    if (entry.difficulty === "HARD" && (
      dimension.sourceCount !== 2
      || dimension.plausibleHypotheses < 1
      || Math.max(dimension.temporalCorrelationTrap, dimension.causalDirectness,
        dimension.evidenceCompleteness) < 2
    )) {
      addIssue(gates, "difficultyBalance", { status: "FAIL", code: "HARD_STRUCTURE_MISMATCH",
        reason: "HARD cases require 3+ sources, competing hypotheses, and a trap, indirectness, or conflict.", caseId });
    }
  }

  const requiredTools = Array.isArray(entry.requiredTools) ? entry.requiredTools : [];
  if (duplicates(requiredTools).length > 0) {
    addIssue(gates, "toolSolvability", { status: "FAIL", code: "DUPLICATE_REQUIRED_TOOL",
      reason: "requiredTools must be unique.", caseId });
  }
  const manual = record(entry.manualReview);
  const reviewNotes = Array.isArray(manual.notes) ? manual.notes : [];
  if (reviewNotes.length === 0 || reviewNotes.some((item) => !text(item))) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_MANUAL_REVIEW_NOTES",
      reason: "Manual review requires at least one non-empty governance note.", caseId });
  }
  for (const [field, gate] of [
    ["groundTruthSemantics", "groundTruthIntegrity"],
    ["toolSolvability", "toolSolvability"],
    ["splitSimilarity", "splitLeakage"],
  ] as const) {
    if (manual[field] !== "APPROVED") {
      addIssue(gates, gate, { status: "MANUAL_REVIEW", code: `MANUAL_${field.toUpperCase()}_REQUIRED`,
        reason: `${field} requires recorded human review.`, caseId });
    }
  }
};

const validateProvenance = (
  entry: DatasetCaseEntry,
  gates: Record<DatasetGateName, DatasetGateReport>,
) => {
  const provenance = record(entry.provenance);
  const caseId = text(entry.caseId) || undefined;
  if (!(DATASET_SOURCE_TYPES as readonly unknown[]).includes(provenance.sourceType)
    || !text(provenance.description)) {
    addIssue(gates, "provenance", { status: "FAIL", code: "INVALID_PROVENANCE",
      reason: "Every case requires a valid sourceType and non-empty description.", caseId });
    return;
  }
  if (provenance.sourceType === "adapted_public_pattern"
    && (!text(provenance.sourceReference) || !text(provenance.adaptationNotes))) {
    addIssue(gates, "provenance", { status: "FAIL", code: "INCOMPLETE_PUBLIC_PROVENANCE",
      reason: "Adapted public patterns require a source reference and adaptation notes.", caseId });
  }
};

const validateFixture = (
  entry: DatasetCaseEntry,
  fixture: GovernedBenchmarkCaseFixture,
  gates: Record<DatasetGateName, DatasetGateReport>,
) => {
  const benchmarkCase = fixture.benchmarkCase;
  const groundTruth = benchmarkCase.groundTruth;
  const caseId = entry.caseId;
  if (fixture.schemaVersion !== DATASET_SCHEMA_VERSION || fixture.fixtureRef !== entry.fixtureRef) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "FIXTURE_CONTRACT_MISMATCH",
      reason: "Fixture schemaVersion and fixtureRef must match the manifest.", caseId });
  }
  try {
    deriveBenchmarkExecutionRequest(benchmarkCase);
  } catch (caught) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_EXECUTION_BOUNDARY",
      reason: caught instanceof Error ? caught.message : "Execution input could not be derived.", caseId });
  }

  const canonical = text(groundTruth?.canonicalRootCause);
  const canonicalId = text(groundTruth?.canonicalRootCauseId);
  if (!canonical || !canonicalId) {
    addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "MISSING_CANONICAL_ROOT_CAUSE",
      reason: "Ground Truth requires canonicalRootCauseId and canonicalRootCause.", caseId });
  }
  const aliases = Array.isArray(groundTruth?.acceptableAliases)
    ? groundTruth.acceptableAliases.map(text)
    : [];
  if (aliases.some((alias) => !alias) || duplicates(aliases.map(normalizeAnswer)).length > 0
    || aliases.some((alias) => normalizeAnswer(alias) === normalizeAnswer(canonical))) {
    addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "INVALID_ROOT_CAUSE_ALIASES",
      reason: "Aliases must be non-empty, unique, and different from the canonical answer.", caseId });
  }

  const required = Array.isArray(groundTruth?.requiredEvidenceIds)
    ? groundTruth.requiredEvidenceIds : [];
  const supporting = Array.isArray(groundTruth?.supportingEvidenceIds)
    ? groundTruth.supportingEvidenceIds : [];
  const distractors = Array.isArray(groundTruth?.distractorEvidenceIds)
    ? groundTruth.distractorEvidenceIds : [];
  for (const [label, values] of [
    ["required", required], ["supporting", supporting], ["distractor", distractors],
  ] as const) {
    if (duplicates(values).length > 0) {
      addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "DUPLICATE_EVIDENCE_ID",
        reason: `${label} evidence IDs must be unique.`, caseId });
    }
  }
  const supportingSet = new Set(supporting);
  const distractorSet = new Set(distractors);
  if (required.some((id) => !supportingSet.has(id))) {
    addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "REQUIRED_NOT_SUPPORTING",
      reason: "Every required evidence ID must also be supporting evidence.", caseId });
  }
  if (supporting.some((id) => distractorSet.has(id))) {
    addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "EVIDENCE_LABEL_CONFLICT",
      reason: "Supporting and distractor evidence cannot overlap.", caseId });
  }

  const observationById = new Map(fixture.evidence.map((item) => [item.evidenceId, item]));
  const sourceEvidenceIds = benchmarkCase.dataSources.flatMap((source) => source.evidenceIds);
  const fixtureEvidenceIds = fixture.evidence.map((item) => item.evidenceId);
  const duplicateSourceIds = duplicates(benchmarkCase.dataSources.map((source) => source.sourceId));
  const duplicateDeclaredEvidence = duplicates(sourceEvidenceIds);
  const duplicateObservations = duplicates(fixtureEvidenceIds);
  if (duplicateSourceIds.length > 0 || duplicateDeclaredEvidence.length > 0
    || duplicateObservations.length > 0) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "DUPLICATE_FIXTURE_IDENTIFIER",
      reason: "Source IDs, declared evidence IDs, and observation evidence IDs must be unique per case.", caseId });
  }
  const groundTruthIds = [...new Set([...supporting, ...distractors])];
  if (groundTruthIds.some((id) => !observationById.has(id)
    || !sourceEvidenceIds.includes(id))) {
    addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "MISSING_EVIDENCE_REFERENCE",
      reason: "Every Ground Truth evidence ID must resolve in the fixture and a declared data source.", caseId });
  }
  if (!sameStringSet(sourceEvidenceIds, fixtureEvidenceIds)) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "FIXTURE_EVIDENCE_SET_MISMATCH",
      reason: "Fixture observations must exactly match data-source evidence IDs.", caseId });
  }

  const allowedTools = new Set(modelToolDefinitions.map((item) => item.function.name));
  const sourceById = new Map(benchmarkCase.dataSources.map((source) => [source.sourceId, source]));
  for (const observation of fixture.evidence) {
    const source = sourceById.get(observation.sourceId);
    if (!allowedTools.has(observation.toolName) || !source
      || TOOL_SOURCE_KIND[observation.toolName] !== source.kind) {
      addIssue(gates, "toolSolvability", { status: "FAIL", code: "UNOBSERVABLE_EVIDENCE",
        reason: `Evidence ${observation.evidenceId} is not obtainable through a current allowed tool.`, caseId });
    }
  }
  const supportingObservations = supporting.flatMap((id) => {
    const observation = observationById.get(id);
    return observation ? [observation] : [];
  });
  const supportingTools = supportingObservations.map((item) => item.toolName);
  const expectedDistractorScore = distractors.length <= 1 ? 0 : distractors.length <= 3 ? 1 : 2;
  const supportingSourceCount = new Set(supportingObservations.map((item) => item.sourceId)).size;
  const expectedSourceScore = supportingSourceCount <= 1 ? 0 : supportingSourceCount === 2 ? 1 : 2;
  if (entry.difficultyDimensions.distractorCount !== expectedDistractorScore
    || entry.difficultyDimensions.sourceCount !== expectedSourceScore) {
    addIssue(gates, "difficultyBalance", { status: "FAIL", code: "DERIVED_DIFFICULTY_MISMATCH",
      reason: "Distractor and required-source dimension scores must match fixture structure.", caseId });
  }
  if (!sameStringSet(entry.requiredTools, supportingTools)) {
    addIssue(gates, "toolSolvability", { status: "FAIL", code: "REQUIRED_TOOL_MISMATCH",
      reason: "requiredTools must exactly describe the tools needed for supporting evidence.", caseId });
  }
  if (supportingObservations.some((item) => item.observationScope !== "CURRENT_INCIDENT")) {
    addIssue(gates, "toolSolvability", { status: "FAIL", code: "HISTORICAL_EVIDENCE_AS_PROOF",
      reason: "Historical incident matches cannot be labeled as supporting Ground Truth evidence.", caseId });
  }
  if (benchmarkCase.category !== "insufficient_evidence") {
    if (RESERVED_POSITIVE_CATEGORIES.has(benchmarkCase.category)) {
      addIssue(gates, "toolSolvability", { status: "FAIL", code: "RESERVED_UNSOLVABLE_CATEGORY",
        reason: `${benchmarkCase.category} has no current observation tool for a positive diagnosis.`, caseId });
    }
    const hasCurrentRequired = required.some((id) =>
      observationById.get(id)?.observationScope === "CURRENT_INCIDENT");
    if (!hasCurrentRequired) {
      addIssue(gates, "toolSolvability", { status: "FAIL", code: "NO_CURRENT_REQUIRED_EVIDENCE",
        reason: "Positive cases require current-incident required evidence.", caseId });
    }
  }

  const evidenceIds = new Set(fixture.evidence.map((item) => item.evidenceId));
  if (fixture.evidenceGraph.edges.some((edge) =>
    !evidenceIds.has(edge.fromEvidenceId) || !evidenceIds.has(edge.toEvidenceId))) {
    addIssue(gates, "groundTruthIntegrity", { status: "FAIL", code: "INVALID_EVIDENCE_GRAPH_EDGE",
      reason: "Every evidence graph edge must reference existing observations.", caseId });
  }

  const answerForms = [canonical, ...aliases].map(normalizeAnswer).filter((value) => value.length >= 8);
  const visibleMetadata = [benchmarkCase.title, benchmarkCase.input.question,
    entry.caseId, entry.fixtureRef, ...benchmarkCase.dataSources.flatMap((source) =>
      [source.sourceId, source.fixtureRef])].map((value) => normalizeAnswer(String(value)));
  if (answerForms.some((answer) => visibleMetadata.some((value) => value.includes(answer)))) {
    addIssue(gates, "splitLeakage", { status: "FAIL", code: "EXACT_ANSWER_METADATA_LEAKAGE",
      reason: "Canonical answer or alias appears verbatim in execution-visible or identifying metadata.", caseId });
  }
};

const validateFormalDistribution = (
  entries: DatasetCaseEntry[],
  purpose: string,
  gates: Record<DatasetGateName, DatasetGateReport>,
) => {
  const enabled = entries.filter((entry) => entry.enabled);
  if (purpose === "TEST_ONLY") return;
  const expectedTotal = purpose === "GOVERNED_DEV" ? 22 : 36;
  if (enabled.length !== expectedTotal) {
    addIssue(gates, "coverage", { status: "FAIL", code: "FORMAL_CASE_COUNT_MISMATCH",
      reason: `The ${purpose} profile requires exactly ${expectedTotal} enabled cases.` });
  }
  if (purpose === "GOVERNED_DEV" && enabled.some((entry) => entry.split !== "DEV")) {
    addIssue(gates, "coverage", { status: "FAIL", code: "DEV_PROFILE_CONTAINS_HOLDOUT",
      reason: "The governed Dev profile cannot contain HOLDOUT entries." });
  }
  for (const [category, expected] of Object.entries(FORMAL_CATEGORY_COUNTS)) {
    const splits = purpose === "GOVERNED_DEV" ? ["DEV"] as const : DATASET_SPLITS;
    for (const split of splits) {
      const actual = enabled.filter((entry) =>
        entry.category === category && entry.split === split).length;
      if (actual !== expected[split]) {
        addIssue(gates, "coverage", { status: "FAIL", code: "CATEGORY_COVERAGE_MISMATCH",
          reason: `${category}/${split} requires ${expected[split]} enabled cases; received ${actual}.` });
      }
    }
  }
  if (enabled.some((entry) => RESERVED_POSITIVE_CATEGORIES.has(entry.category))) {
    addIssue(gates, "coverage", { status: "FAIL", code: "RESERVED_CATEGORY_INCLUDED",
      reason: "Database and infrastructure positive categories are reserved until tools exist." });
  }
  if (purpose === "GOVERNED_DEV") {
    const counts = Object.fromEntries(DATASET_DIFFICULTIES.map((difficulty) => [
      difficulty,
      enabled.filter((entry) => entry.difficulty === difficulty).length,
    ])) as Record<DatasetDifficulty, number>;
    if (counts.EASY === 0 || counts.MEDIUM === 0 || counts.HARD === 0
      || counts.MEDIUM < counts.EASY || counts.MEDIUM < counts.HARD) {
      addIssue(gates, "difficultyBalance", { status: "FAIL", code: "DEV_DIFFICULTY_PROFILE_MISMATCH",
        reason: "Governed Dev must cover all difficulty levels with MEDIUM as the largest group." });
    }
  } else {
    for (const [difficulty, expected] of Object.entries(FORMAL_DIFFICULTY_COUNTS)) {
      for (const split of DATASET_SPLITS) {
        const actual = enabled.filter((entry) =>
          entry.difficulty === difficulty && entry.split === split).length;
        if (actual !== expected[split]) {
          addIssue(gates, "difficultyBalance", { status: "FAIL", code: "DIFFICULTY_DISTRIBUTION_MISMATCH",
            reason: `${difficulty}/${split} requires ${expected[split]} enabled cases; received ${actual}.` });
        }
      }
    }
  }
};

const validateBalance = (
  entries: DatasetCaseEntry[],
  fixtures: Map<string, GovernedBenchmarkCaseFixture>,
  purpose: string,
  gates: Record<DatasetGateName, DatasetGateReport>,
) => {
  if (purpose === "TEST_ONLY") return;
  const enabled = entries.filter((entry) => entry.enabled);
  const rootCauseCounts = new Map<string, number>();
  const templateCounts = new Map<string, number>();
  for (const entry of enabled) {
    const rootCauseId = fixtures.get(entry.fixtureRef)?.benchmarkCase.groundTruth.canonicalRootCauseId;
    if (rootCauseId) rootCauseCounts.set(rootCauseId, (rootCauseCounts.get(rootCauseId) ?? 0) + 1);
    templateCounts.set(entry.templateFamily, (templateCounts.get(entry.templateFamily) ?? 0) + 1);
  }
  if ([...rootCauseCounts.values()].some((count) => count / enabled.length > 0.25)) {
    addIssue(gates, "categoryBalance", { status: "FAIL", code: "ROOT_CAUSE_FAMILY_DOMINANCE",
      reason: "No canonical root-cause family may exceed 25% of enabled cases." });
  }
  if ([...templateCounts.values()].some((count) => count > 2)) {
    addIssue(gates, "categoryBalance", { status: "FAIL", code: "TEMPLATE_FAMILY_DOMINANCE",
      reason: "No exact template family may appear more than twice." });
  }
};

const validateCrossCaseLeakage = async (
  entries: DatasetCaseEntry[],
  fixtures: Map<string, GovernedBenchmarkCaseFixture>,
  gates: Record<DatasetGateName, DatasetGateReport>,
) => {
  const enabled = entries.filter((entry) => entry.enabled && fixtures.has(entry.fixtureRef));
  const exact = new Map<string, string[]>();
  const structural = new Map<string, string[]>();
  for (const entry of enabled) {
    const fixture = fixtures.get(entry.fixtureRef)!;
    const exactHash = await exactFixtureFingerprint(fixture);
    const structuralHash = await structuralFixtureFingerprint(fixture);
    exact.set(exactHash, [...(exact.get(exactHash) ?? []), entry.caseId]);
    structural.set(structuralHash, [...(structural.get(structuralHash) ?? []), entry.caseId]);
  }
  const entryByCase = new Map(entries.map((entry) => [entry.caseId, entry]));
  for (const [fingerprint, caseIds] of exact) {
    if (caseIds.length < 2) continue;
    const splits = new Set(caseIds.map((id) => entryByCase.get(id)?.split));
    addIssue(gates, "duplicateDetection", {
      status: splits.size > 1 ? "FAIL" : "WARN",
      code: splits.size > 1 ? "CROSS_SPLIT_FIXTURE_REUSE" : "SAME_SPLIT_FIXTURE_REUSE",
      reason: `Cases ${caseIds.join(", ")} share exact fixture fingerprint ${fingerprint}.`,
    });
  }
  for (const [fingerprint, caseIds] of structural) {
    if (caseIds.length < 2) continue;
    const splits = new Set(caseIds.map((id) => entryByCase.get(id)?.split));
    addIssue(gates, "duplicateDetection", {
      status: splits.size > 1 ? "FAIL" : "WARN",
      code: splits.size > 1 ? "CROSS_SPLIT_STRUCTURAL_DUPLICATE" : "STRUCTURAL_DUPLICATE_REVIEW",
      reason: `Cases ${caseIds.join(", ")} share structural fingerprint ${fingerprint}.`,
    });
  }

  const byTemplate = new Map<string, DatasetCaseEntry[]>();
  const byFixtureRef = new Map<string, DatasetCaseEntry[]>();
  for (const entry of enabled) {
    byTemplate.set(entry.templateFamily, [...(byTemplate.get(entry.templateFamily) ?? []), entry]);
    byFixtureRef.set(entry.fixtureRef, [...(byFixtureRef.get(entry.fixtureRef) ?? []), entry]);
  }
  for (const group of byTemplate.values()) {
    if (new Set(group.map((entry) => entry.split)).size > 1) {
      addIssue(gates, "splitLeakage", { status: "FAIL", code: "CROSS_SPLIT_TEMPLATE_FAMILY",
        reason: `Template family ${group[0].templateFamily} appears in DEV and HOLDOUT.` });
    }
  }
  for (const group of byFixtureRef.values()) {
    if (new Set(group.map((entry) => entry.split)).size > 1) {
      addIssue(gates, "splitLeakage", { status: "FAIL", code: "CROSS_SPLIT_FIXTURE_REFERENCE",
        reason: `Fixture ${group[0].fixtureRef} is referenced from DEV and HOLDOUT.` });
    }
  }
};

export async function validateInvestigationBenchmarkDataset(
  definition: InvestigationBenchmarkDatasetDefinition,
): Promise<InvestigationBenchmarkDatasetValidationReport> {
  const gates = blankGates();
  const manifest = definition.manifest;
  const entries = Array.isArray(manifest?.caseEntries) ? manifest.caseEntries : [];
  const fixtures = Array.isArray(definition.fixtures) ? definition.fixtures : [];
  const fixtureByRef = new Map(fixtures.map((fixture) => [fixture.fixtureRef, fixture]));

  if (manifest?.schemaVersion !== DATASET_SCHEMA_VERSION || !text(manifest?.datasetId)
    || !/^\d+\.\d+\.\d+$/.test(text(manifest?.version))
    || !text(manifest?.evaluationContractVersion)
    || !validIsoDate(manifest?.createdAt) || !validIsoDate(manifest?.updatedAt)
    || !["GOVERNED_BENCHMARK", "GOVERNED_DEV", "TEST_ONLY"].includes(manifest?.purpose)) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "INVALID_MANIFEST",
      reason: "Manifest identity, purpose, semantic version, contract version, and timestamps are required." });
  }
  const duplicateCaseIds = duplicates(entries.map((entry) => text(entry.caseId)));
  if (duplicateCaseIds.length > 0) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "DUPLICATE_CASE_ID",
      reason: `Duplicate case IDs: ${duplicateCaseIds.join(", ")}.` });
  }
  if (duplicates(fixtures.map((fixture) => text(fixture.fixtureRef))).length > 0) {
    addIssue(gates, "manifestIntegrity", { status: "FAIL", code: "DUPLICATE_FIXTURE_REFERENCE",
      reason: "Fixture references must be unique." });
  }
  const referencedFixtures = new Set(entries.map((entry) => entry.fixtureRef));
  for (const fixture of fixtures) {
    if (!referencedFixtures.has(fixture.fixtureRef)) {
      addIssue(gates, "manifestIntegrity", { status: "WARN", code: "UNREFERENCED_TEST_FIXTURE",
        reason: `Fixture ${fixture.fixtureRef} is not referenced by the manifest.` });
    }
  }

  for (const entry of entries) {
    const fixture = fixtureByRef.get(entry.fixtureRef);
    validateManifestEntry(entry, fixture, gates);
    validateProvenance(entry, gates);
    if (fixture) validateFixture(entry, fixture, gates);
  }
  validateFormalDistribution(entries, manifest?.purpose, gates);
  validateBalance(entries, fixtureByRef, manifest?.purpose, gates);
  await validateCrossCaseLeakage(entries, fixtureByRef, gates);

  const calculatedDatasetHash = await calculateInvestigationBenchmarkDatasetHash(definition);
  const secondHash = await calculateInvestigationBenchmarkDatasetHash(structuredClone(definition));
  if (calculatedDatasetHash !== secondHash) {
    addIssue(gates, "determinism", { status: "FAIL", code: "NONDETERMINISTIC_DATASET_HASH",
      reason: "Repeated canonical hashing produced different values." });
  }
  const expected = manifest?.expectedDatasetHash ?? null;
  if (expected === null) {
    addIssue(gates, "datasetHash", { status: "MANUAL_REVIEW", code: "DATASET_NOT_LOCKED",
      reason: "expectedDatasetHash is absent; explicitly lock the validated definition." });
  } else if (!/^[a-f0-9]{64}$/.test(expected) || expected !== calculatedDatasetHash) {
    addIssue(gates, "datasetHash", { status: "FAIL", code: "DATASET_HASH_MISMATCH",
      reason: "Manifest expectedDatasetHash does not match the canonical dataset definition." });
  }

  const gateStatuses = Object.values(gates).map((gate) => gate.status);
  const status = gateStatuses.reduce<DatasetGateStatus>((highest, current) =>
    STATUS_RANK[current] > STATUS_RANK[highest] ? current : highest, "PASS");
  return {
    status,
    valid: status !== "FAIL",
    datasetId: text(manifest?.datasetId),
    datasetVersion: text(manifest?.version),
    calculatedDatasetHash,
    expectedDatasetHash: expected,
    gates,
  };
}

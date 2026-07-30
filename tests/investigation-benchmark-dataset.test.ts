import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateInvestigationBenchmarkDatasetHash,
  lockInvestigationBenchmarkDataset,
} from "../eval/investigation-benchmark/dataset/hash";
import type {
  DatasetCaseEntry,
  DatasetEvidenceObservation,
  GovernedBenchmarkCaseFixture,
  InvestigationBenchmarkDatasetDefinition,
} from "../eval/investigation-benchmark/dataset/types";
import {
  validateInvestigationBenchmarkDataset,
} from "../eval/investigation-benchmark/dataset/validator";

const NOW = "2030-01-01T00:00:00.000Z";

const review = () => ({
  groundTruthSemantics: "APPROVED" as const,
  toolSolvability: "APPROVED" as const,
  splitSimilarity: "APPROVED" as const,
  notes: ["TEST ONLY governance attestation"],
});

const provenance = () => ({
  sourceType: "synthetic" as const,
  description: "TEST ONLY validator fixture; not a benchmark case.",
});

const causalRubric = () => ({
  expectedAnswerMode: "CAUSAL" as const,
  requiredConceptGroups: [],
  optionalConcepts: [],
  forbiddenConcepts: [],
  uncertaintyPolicy: "NOT_APPLICABLE" as const,
  specificityPolicy: "ALLOW_MORE_SPECIFIC_IF_CONSISTENT" as const,
});

const entry = (input: Omit<DatasetCaseEntry,
  "schemaVersion" | "provenance" | "manualReview" | "enabled">): DatasetCaseEntry => ({
  schemaVersion: "1",
  provenance: provenance(),
  manualReview: review(),
  enabled: true,
  ...input,
});

const observation = (
  evidenceId: string,
  sourceId: string,
  toolName: string,
  role: DatasetEvidenceObservation["role"],
  payload: unknown,
): DatasetEvidenceObservation => ({
  evidenceId,
  sourceId,
  toolName,
  observationScope: "CURRENT_INCIDENT",
  role,
  payload,
});

const fixtureA: GovernedBenchmarkCaseFixture = {
  schemaVersion: "1",
  fixtureRef: "test-only-fixture://FX-101",
  benchmarkCase: {
    caseId: "CASE-101",
    title: "TEST ONLY checkout regression",
    category: "release_regression",
    difficulty: "easy",
    input: {
      incidentId: "INC-101",
      question: "What caused the checkout decline?",
      riskEvent: null,
    },
    dataSources: [{
      sourceId: "SRC-101",
      kind: "analytics",
      fixtureRef: "fixture://SRC-101",
      evidenceIds: ["EV-101", "EV-102"],
    }],
    groundTruth: {
      rootCauseEvaluation: causalRubric(),
      canonicalRootCauseId: "RC-101",
      canonicalRootCause: "The latest release changed checkout confirmation behavior.",
      acceptableAliases: ["Checkout confirmation regressed in the latest release"],
      requiredEvidenceIds: ["EV-101"],
      supportingEvidenceIds: ["EV-101"],
      distractorEvidenceIds: ["EV-102"],
    },
  },
  evidence: [
    observation("EV-101", "SRC-101", "query_metric", "CAUSAL", { series: [0.9, 0.5] }),
    observation("EV-102", "SRC-101", "query_metric", "DISTRACTOR", { series: [0.7, 0.7] }),
  ],
  evidenceGraph: { edges: [] },
  fixtureData: { testOnly: true, metricBuckets: [90, 50] },
};

const fixtureB: GovernedBenchmarkCaseFixture = {
  schemaVersion: "1",
  fixtureRef: "test-only-fixture://FX-102",
  benchmarkCase: {
    caseId: "CASE-102",
    title: "TEST ONLY rollout configuration",
    category: "configuration",
    difficulty: "medium",
    input: {
      incidentId: "INC-102",
      question: "Why did the affected cohort diverge?",
      riskEvent: null,
    },
    dataSources: [
      { sourceId: "SRC-201", kind: "release", fixtureRef: "fixture://SRC-201",
        evidenceIds: ["EV-201"] },
      { sourceId: "SRC-202", kind: "analytics", fixtureRef: "fixture://SRC-202",
        evidenceIds: ["EV-202", "EV-203"] },
    ],
    groundTruth: {
      rootCauseEvaluation: causalRubric(),
      canonicalRootCauseId: "RC-102",
      canonicalRootCause: "The declared rollout configuration exposed the wrong cohort.",
      acceptableAliases: ["Incorrect cohort exposure from rollout configuration"],
      requiredEvidenceIds: ["EV-201", "EV-202"],
      supportingEvidenceIds: ["EV-201", "EV-202"],
      distractorEvidenceIds: ["EV-203"],
    },
  },
  evidence: [
    observation("EV-201", "SRC-201", "get_release", "CONTEXT", { rollout: 100 }),
    observation("EV-202", "SRC-202", "segment_metric", "CAUSAL", { cohorts: [0.4, 0.95] }),
    observation("EV-203", "SRC-202", "query_metric", "DISTRACTOR", { overall: 0.8 }),
  ],
  evidenceGraph: { edges: [{
    fromEvidenceId: "EV-201", toEvidenceId: "EV-202", relation: "SUPPORTS",
  }] },
  fixtureData: { testOnly: true, release: { rolloutPercentage: 100 }, cohorts: 2 },
};

const fixtureC: GovernedBenchmarkCaseFixture = {
  schemaVersion: "1",
  fixtureRef: "test-only-fixture://FX-103",
  benchmarkCase: {
    caseId: "CASE-103",
    title: "TEST ONLY incomplete investigation",
    category: "insufficient_evidence",
    difficulty: "hard",
    input: {
      incidentId: "INC-103",
      question: "Can the available evidence identify one cause?",
      riskEvent: null,
    },
    dataSources: [
      { sourceId: "SRC-301", kind: "release", fixtureRef: "fixture://SRC-301",
        evidenceIds: ["EV-301"] },
      { sourceId: "SRC-302", kind: "analytics", fixtureRef: "fixture://SRC-302",
        evidenceIds: ["EV-302"] },
      { sourceId: "SRC-303", kind: "feedback", fixtureRef: "fixture://SRC-303",
        evidenceIds: ["EV-303", "EV-304"] },
    ],
    groundTruth: {
      rootCauseEvaluation: {
        ...causalRubric(),
        expectedAnswerMode: "ABSTAIN",
        uncertaintyPolicy: "REQUIRE_ABSTENTION",
      },
      canonicalRootCauseId: "RC-103",
      canonicalRootCause: "Available evidence cannot reliably identify one root cause.",
      acceptableAliases: ["The current evidence is insufficient to choose a cause"],
      requiredEvidenceIds: ["EV-301", "EV-302", "EV-303"],
      supportingEvidenceIds: ["EV-301", "EV-302", "EV-303"],
      distractorEvidenceIds: ["EV-304"],
    },
  },
  evidence: [
    observation("EV-301", "SRC-301", "get_release", "CONTEXT", { modules: ["Shell"] }),
    observation("EV-302", "SRC-302", "segment_metric", "NEGATIVE", { sample: "LOW" }),
    observation("EV-303", "SRC-303", "search_user_feedback", "SYMPTOM", { matches: [] }),
    observation("EV-304", "SRC-303", "search_user_feedback", "DISTRACTOR", { matches: ["noise"] }),
  ],
  evidenceGraph: { edges: [
    { fromEvidenceId: "EV-301", toEvidenceId: "EV-302", relation: "CONTRADICTS" },
    { fromEvidenceId: "EV-302", toEvidenceId: "EV-303", relation: "CONTEXT" },
  ] },
  fixtureData: { testOnly: true, unavailable: ["DECISIVE_CURRENT_SIGNAL"], sampleSize: 12 },
};

const unlockedDataset = (): InvestigationBenchmarkDatasetDefinition => ({
  manifest: {
    schemaVersion: "1",
    datasetId: "DATASET-TEST-ONLY-001",
    purpose: "TEST_ONLY",
    version: "0.0.1",
    evaluationContractVersion: "phase1a-v1",
    createdAt: NOW,
    updatedAt: NOW,
    expectedDatasetHash: null,
    caseEntries: [
      entry({ caseId: "CASE-101", split: "DEV", category: "release_regression",
        difficulty: "EASY", difficultyScore: 0,
        difficultyDimensions: { distractorCount: 0, plausibleHypotheses: 0, sourceCount: 0,
          causalDirectness: 0, temporalCorrelationTrap: 0, evidenceCompleteness: 0 },
        templateFamily: "TPL-101", fixtureRef: fixtureA.fixtureRef,
        requiredTools: ["query_metric"] }),
      entry({ caseId: "CASE-102", split: "HOLDOUT", category: "configuration",
        difficulty: "MEDIUM", difficultyScore: 4,
        difficultyDimensions: { distractorCount: 0, plausibleHypotheses: 1, sourceCount: 1,
          causalDirectness: 1, temporalCorrelationTrap: 1, evidenceCompleteness: 0 },
        templateFamily: "TPL-102", fixtureRef: fixtureB.fixtureRef,
        requiredTools: ["get_release", "segment_metric"] }),
      entry({ caseId: "CASE-103", split: "DEV", category: "insufficient_evidence",
        difficulty: "HARD", difficultyScore: 8,
        difficultyDimensions: { distractorCount: 0, plausibleHypotheses: 1, sourceCount: 2,
          causalDirectness: 2, temporalCorrelationTrap: 1, evidenceCompleteness: 2 },
        templateFamily: "TPL-103", fixtureRef: fixtureC.fixtureRef,
        requiredTools: ["get_release", "segment_metric", "search_user_feedback"] }),
    ],
  },
  fixtures: [structuredClone(fixtureA), structuredClone(fixtureB), structuredClone(fixtureC)],
});

const issueCodes = (report: Awaited<ReturnType<typeof validateInvestigationBenchmarkDataset>>) =>
  Object.values(report.gates).flatMap((gate) => gate.issues.map((issue) => issue.code));

const reverseObjectKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]));
  }
  return value;
};

const validateLockedMutation = async (
  mutate: (definition: InvestigationBenchmarkDatasetDefinition) => void,
) => {
  const definition = unlockedDataset();
  mutate(definition);
  return validateInvestigationBenchmarkDataset(await lockInvestigationBenchmarkDataset(definition));
};

test("TEST ONLY valid dataset passes every governance gate", async () => {
  const report = await validateInvestigationBenchmarkDataset(
    await lockInvestigationBenchmarkDataset(unlockedDataset()),
  );
  assert.equal(report.valid, true);
  assert.equal(report.status, "PASS");
  assert.equal(report.gates.toolSolvability.status, "PASS");
  assert.equal(report.gates.datasetHash.status, "PASS");
  assert.match(report.calculatedDatasetHash, /^[a-f0-9]{64}$/);
});

test("manifest integrity rejects duplicate case IDs, missing provenance, and invalid categories", async () => {
  const duplicate = await validateLockedMutation((definition) => {
    definition.manifest.caseEntries[1].caseId = "CASE-101";
  });
  assert.ok(issueCodes(duplicate).includes("DUPLICATE_CASE_ID"));

  const missingProvenance = await validateLockedMutation((definition) => {
    (definition.manifest.caseEntries[0] as Partial<DatasetCaseEntry>).provenance = undefined;
  });
  assert.ok(issueCodes(missingProvenance).includes("INVALID_PROVENANCE"));

  const invalidCategory = await validateLockedMutation((definition) => {
    (definition.manifest.caseEntries[0] as { category: string }).category = "database_lock";
  });
  assert.ok(issueCodes(invalidCategory).includes("INVALID_CATEGORY"));
});

test("difficulty score and structural level mismatches fail deterministically", async () => {
  const report = await validateLockedMutation((definition) => {
    definition.manifest.caseEntries[0].difficultyScore = 7;
  });
  assert.equal(report.gates.difficultyBalance.status, "FAIL");
  assert.ok(issueCodes(report).includes("DIFFICULTY_SCORE_MISMATCH"));
});

test("formal profile enforces the frozen category and difficulty split matrix", async () => {
  const report = await validateLockedMutation((definition) => {
    definition.manifest.purpose = "GOVERNED_BENCHMARK";
  });
  assert.equal(report.gates.coverage.status, "FAIL");
  assert.equal(report.gates.difficultyBalance.status, "FAIL");
  assert.ok(issueCodes(report).includes("CATEGORY_COVERAGE_MISMATCH"));
  assert.ok(issueCodes(report).includes("DIFFICULTY_DISTRIBUTION_MISMATCH"));
});

test("Ground Truth rejects missing references, label conflicts, and duplicate aliases", async () => {
  const missing = await validateLockedMutation((definition) => {
    const groundTruth = definition.fixtures[0].benchmarkCase.groundTruth;
    groundTruth.requiredEvidenceIds.push("EV-999");
    groundTruth.supportingEvidenceIds.push("EV-999");
  });
  assert.ok(issueCodes(missing).includes("MISSING_EVIDENCE_REFERENCE"));

  const conflict = await validateLockedMutation((definition) => {
    definition.fixtures[0].benchmarkCase.groundTruth.distractorEvidenceIds.push("EV-101");
  });
  assert.ok(issueCodes(conflict).includes("EVIDENCE_LABEL_CONFLICT"));

  const alias = await validateLockedMutation((definition) => {
    const groundTruth = definition.fixtures[0].benchmarkCase.groundTruth;
    groundTruth.acceptableAliases.push(groundTruth.canonicalRootCause);
  });
  assert.ok(issueCodes(alias).includes("INVALID_ROOT_CAUSE_ALIASES"));

  const duplicateFixtureId = await validateLockedMutation((definition) => {
    definition.fixtures[0].evidence.push(structuredClone(definition.fixtures[0].evidence[0]));
  });
  assert.ok(issueCodes(duplicateFixtureId).includes("DUPLICATE_FIXTURE_IDENTIFIER"));
});

test("Ground Truth rejects uncontrolled, empty, conflicting, and mode-inconsistent semantic rubrics", async () => {
  const uncontrolled = await validateLockedMutation((definition) => {
    const rubric = definition.fixtures[0].benchmarkCase.groundTruth.rootCauseEvaluation;
    rubric.requiredConceptGroups = [{ id: "cause", anyOf: ["DATABASE_LOCK"] }];
    rubric.forbiddenConcepts = ["DATABASE_LOCK"];
  });
  assert.ok(issueCodes(uncontrolled).includes("CONFLICTING_SEMANTIC_CONCEPT"));

  const emptyGroup = await validateLockedMutation((definition) => {
    definition.fixtures[0].benchmarkCase.groundTruth.rootCauseEvaluation.requiredConceptGroups = [
      { id: "", anyOf: [] },
    ];
  });
  assert.ok(issueCodes(emptyGroup).includes("INVALID_SEMANTIC_CONCEPT_GROUP"));

  const modeMismatch = await validateLockedMutation((definition) => {
    const rubric = definition.fixtures[0].benchmarkCase.groundTruth.rootCauseEvaluation;
    rubric.expectedAnswerMode = "ABSTAIN";
  });
  assert.ok(issueCodes(modeMismatch).includes("ANSWER_MODE_POLICY_MISMATCH"));

  const unknownConcept = await validateLockedMutation((definition) => {
    const rubric = definition.fixtures[0].benchmarkCase.groundTruth.rootCauseEvaluation;
    (rubric.optionalConcepts as string[]).push("UNREVIEWED_KEYWORD");
  });
  assert.ok(issueCodes(unknownConcept).includes("UNCONTROLLED_SEMANTIC_CONCEPT"));
});

test("Tool Solvability rejects unavailable positive categories and accepts insufficiency", async () => {
  const unsolvable = await validateLockedMutation((definition) => {
    definition.manifest.caseEntries[0].category = "database";
    definition.fixtures[0].benchmarkCase.category = "database";
  });
  assert.ok(issueCodes(unsolvable).includes("RESERVED_UNSOLVABLE_CATEGORY"));

  const valid = await validateInvestigationBenchmarkDataset(
    await lockInvestigationBenchmarkDataset(unlockedDataset()),
  );
  assert.equal(valid.gates.toolSolvability.status, "PASS");
  assert.equal(valid.gates.groundTruthIntegrity.status, "PASS");
});

test("cross-split template family and fixture reuse fail", async () => {
  const template = await validateLockedMutation((definition) => {
    definition.manifest.caseEntries[1].templateFamily = "TPL-101";
  });
  assert.ok(issueCodes(template).includes("CROSS_SPLIT_TEMPLATE_FAMILY"));

  const fixture = await validateLockedMutation((definition) => {
    definition.manifest.caseEntries[1].fixtureRef = fixtureA.fixtureRef;
  });
  assert.ok(issueCodes(fixture).includes("CROSS_SPLIT_FIXTURE_REFERENCE"));
});

test("normalized structural fingerprint detects superficial cross-split mutation", async () => {
  const report = await validateLockedMutation((definition) => {
    const source = structuredClone(definition.fixtures[0]);
    source.fixtureRef = fixtureB.fixtureRef;
    source.benchmarkCase.caseId = "CASE-102";
    source.benchmarkCase.title = "TEST ONLY renamed checkout behavior";
    source.benchmarkCase.input.incidentId = "INC-202";
    source.benchmarkCase.input.question = "Which behavior explains this metric?";
    source.benchmarkCase.dataSources[0].sourceId = "SRC-211";
    source.benchmarkCase.dataSources[0].fixtureRef = "fixture://SRC-211";
    source.benchmarkCase.dataSources[0].evidenceIds = ["EV-211", "EV-212"];
    source.benchmarkCase.groundTruth = {
      rootCauseEvaluation: causalRubric(),
      canonicalRootCauseId: "RC-202",
      canonicalRootCause: "A renamed release behavior changed completion.",
      acceptableAliases: ["Completion changed because of renamed release behavior"],
      requiredEvidenceIds: ["EV-211"],
      supportingEvidenceIds: ["EV-211"],
      distractorEvidenceIds: ["EV-212"],
    };
    source.evidence = source.evidence.map((item, index) => ({
      ...item,
      evidenceId: index === 0 ? "EV-211" : "EV-212",
      sourceId: "SRC-211",
      payload: { series: index === 0 ? [0.8, 0.4] : [0.6, 0.6] },
    }));
    source.fixtureData = { testOnly: true, metricBuckets: [80, 40] };
    definition.fixtures[1] = source;
    definition.manifest.caseEntries[1] = {
      ...definition.manifest.caseEntries[1],
      category: "release_regression",
      difficulty: "EASY",
      difficultyScore: 0,
      difficultyDimensions: { ...definition.manifest.caseEntries[0].difficultyDimensions },
      requiredTools: ["query_metric"],
    };
  });
  assert.ok(issueCodes(report).includes("CROSS_SPLIT_STRUCTURAL_DUPLICATE"));
});

test("canonical dataset hash ignores ordering, formatting, timestamps, and runtime result fields", async () => {
  const definition = unlockedDataset();
  const baseline = await calculateInvestigationBenchmarkDatasetHash(definition);
  const reordered = reverseObjectKeys(structuredClone(definition)) as
    InvestigationBenchmarkDatasetDefinition;
  reordered.manifest.caseEntries.reverse();
  reordered.fixtures.reverse();
  reordered.fixtures.forEach((fixture) => {
    fixture.benchmarkCase.groundTruth.acceptableAliases.reverse();
    fixture.benchmarkCase.groundTruth.supportingEvidenceIds.reverse();
    fixture.evidence.reverse();
  });
  reordered.manifest.createdAt = "2040-01-01T00:00:00.000Z";
  reordered.manifest.updatedAt = "2040-01-02T00:00:00.000Z";
  const withRuntimeFields = reordered as InvestigationBenchmarkDatasetDefinition & {
    executedAt: string;
    runtimeResults: unknown;
  };
  withRuntimeFields.executedAt = "2040-01-03T00:00:00.000Z";
  withRuntimeFields.runtimeResults = { accuracy: 1, model: "not-part-of-definition" };
  assert.equal(await calculateInvestigationBenchmarkDatasetHash(withRuntimeFields), baseline);
});

test("semantic dataset changes alter hash and stale expected hash fails validation", async () => {
  const locked = await lockInvestigationBenchmarkDataset(unlockedDataset());
  const originalHash = await calculateInvestigationBenchmarkDatasetHash(locked);
  locked.fixtures[0].benchmarkCase.input.question = "A semantically changed investigation question";
  const changedHash = await calculateInvestigationBenchmarkDatasetHash(locked);
  assert.notEqual(changedHash, originalHash);
  const report = await validateInvestigationBenchmarkDataset(locked);
  assert.equal(report.gates.datasetHash.status, "FAIL");
  assert.ok(issueCodes(report).includes("DATASET_HASH_MISMATCH"));
});

test("WARN and MANUAL_REVIEW remain visible and never collapse to PASS", async () => {
  const manual = await validateLockedMutation((definition) => {
    definition.manifest.caseEntries[0].manualReview.splitSimilarity = "REQUIRED";
  });
  assert.equal(manual.gates.splitLeakage.status, "MANUAL_REVIEW");
  assert.equal(manual.status, "MANUAL_REVIEW");
  assert.equal(manual.valid, true);

  const warningDefinition = unlockedDataset();
  warningDefinition.fixtures.push({
    ...structuredClone(fixtureA),
    fixtureRef: "test-only-fixture://FX-999",
  });
  const warning = await validateInvestigationBenchmarkDataset(
    await lockInvestigationBenchmarkDataset(warningDefinition),
  );
  assert.equal(warning.gates.manifestIntegrity.status, "WARN");
  assert.equal(warning.status, "WARN");
  assert.equal(warning.valid, true);
});

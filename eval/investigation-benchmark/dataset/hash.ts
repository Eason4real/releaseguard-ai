import { canonicalJson, sha256 } from "../../../lib/retrieval/public-incidents/normalize";
import type {
  DatasetCaseEntry,
  GovernedBenchmarkCaseFixture,
  InvestigationBenchmarkDatasetDefinition,
} from "./types";

const sortedStrings = (values: readonly string[]) => [...values].sort((left, right) =>
  left.localeCompare(right));

const canonicalEntry = (entry: DatasetCaseEntry) => ({
  schemaVersion: entry.schemaVersion,
  caseId: entry.caseId,
  split: entry.split,
  category: entry.category,
  difficulty: entry.difficulty,
  difficultyScore: entry.difficultyScore,
  difficultyDimensions: entry.difficultyDimensions,
  templateFamily: entry.templateFamily,
  provenance: entry.provenance,
  fixtureRef: entry.fixtureRef,
  requiredTools: sortedStrings(entry.requiredTools),
  manualReview: {
    ...entry.manualReview,
    notes: sortedStrings(entry.manualReview.notes),
  },
  enabled: entry.enabled,
});

const canonicalFixture = (fixture: GovernedBenchmarkCaseFixture) => ({
  schemaVersion: fixture.schemaVersion,
  fixtureRef: fixture.fixtureRef,
  benchmarkCase: {
    ...fixture.benchmarkCase,
    dataSources: [...fixture.benchmarkCase.dataSources]
      .map((source) => ({ ...source, evidenceIds: sortedStrings(source.evidenceIds) }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    groundTruth: {
      ...fixture.benchmarkCase.groundTruth,
      acceptableAliases: sortedStrings(fixture.benchmarkCase.groundTruth.acceptableAliases),
      requiredEvidenceIds: sortedStrings(fixture.benchmarkCase.groundTruth.requiredEvidenceIds),
      supportingEvidenceIds: sortedStrings(fixture.benchmarkCase.groundTruth.supportingEvidenceIds),
      distractorEvidenceIds: sortedStrings(fixture.benchmarkCase.groundTruth.distractorEvidenceIds),
    },
  },
  evidence: [...fixture.evidence].sort((left, right) =>
    left.evidenceId.localeCompare(right.evidenceId)),
  evidenceGraph: {
    edges: [...fixture.evidenceGraph.edges].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))),
  },
  fixtureData: fixture.fixtureData,
});

export const canonicalDatasetDefinition = (
  definition: InvestigationBenchmarkDatasetDefinition,
) => ({
  manifest: {
    schemaVersion: definition.manifest.schemaVersion,
    datasetId: definition.manifest.datasetId,
    purpose: definition.manifest.purpose,
    version: definition.manifest.version,
    evaluationContractVersion: definition.manifest.evaluationContractVersion,
    caseEntries: [...definition.manifest.caseEntries]
      .map(canonicalEntry)
      .sort((left, right) => left.caseId.localeCompare(right.caseId)),
  },
  fixtures: [...definition.fixtures]
    .map(canonicalFixture)
    .sort((left, right) => left.fixtureRef.localeCompare(right.fixtureRef)),
});

export const calculateInvestigationBenchmarkDatasetHash = (
  definition: InvestigationBenchmarkDatasetDefinition,
) => sha256(canonicalJson(canonicalDatasetDefinition(definition)));

export async function lockInvestigationBenchmarkDataset(
  definition: InvestigationBenchmarkDatasetDefinition,
): Promise<InvestigationBenchmarkDatasetDefinition> {
  const expectedDatasetHash = await calculateInvestigationBenchmarkDatasetHash(definition);
  return {
    ...structuredClone(definition),
    manifest: {
      ...structuredClone(definition.manifest),
      expectedDatasetHash,
    },
  };
}

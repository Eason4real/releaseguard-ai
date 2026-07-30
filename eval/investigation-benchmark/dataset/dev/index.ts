import type { InvestigationBenchmarkDatasetDefinition } from "../types";
import { AUTHORED_DEV_CASES } from "./cases";

export const INVESTIGATION_BENCHMARK_DEV_VERSION = "0.1.0";
export const INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH =
  "af80413a7731c19913ac37e193d9ecb45b11b86e7121357e8096144868501abd";

const definition: InvestigationBenchmarkDatasetDefinition = {
  manifest: {
    schemaVersion: "1",
    datasetId: "INVESTIGATION-BENCHMARK-DEV",
    purpose: "GOVERNED_DEV",
    version: INVESTIGATION_BENCHMARK_DEV_VERSION,
    evaluationContractVersion: "phase1a-v1",
    createdAt: "2031-02-01T00:00:00.000Z",
    updatedAt: "2031-02-01T00:00:00.000Z",
    expectedDatasetHash: INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH,
    caseEntries: AUTHORED_DEV_CASES.map((item) => item.entry),
  },
  fixtures: AUTHORED_DEV_CASES.map((item) => item.fixture),
};

export const DEV_CASE_SYMPTOMS = Object.fromEntries(AUTHORED_DEV_CASES.map((item) =>
  [item.entry.caseId, item.symptom]));

export const loadInvestigationBenchmarkDevDataset = () => structuredClone(definition);

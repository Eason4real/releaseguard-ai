import type { InvestigationBenchmarkDatasetDefinition } from "../types";
import { AUTHORED_DEV_CASES } from "./cases";

export const INVESTIGATION_BENCHMARK_DEV_VERSION = "0.2.0";
export const INVESTIGATION_BENCHMARK_DEV_EXPECTED_HASH =
  "c07959702947f821eaf635b68ec2a2d162dee403c3c9ebc3fea2b4689c4fb073";

const definition: InvestigationBenchmarkDatasetDefinition = {
  manifest: {
    schemaVersion: "1",
    datasetId: "INVESTIGATION-BENCHMARK-DEV",
    purpose: "GOVERNED_DEV",
    version: INVESTIGATION_BENCHMARK_DEV_VERSION,
    evaluationContractVersion: "phase1a-v2",
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

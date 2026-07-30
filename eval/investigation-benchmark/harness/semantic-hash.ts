import { canonicalJson, sha256 } from "../../../lib/retrieval/public-incidents/normalize";
import type { DevHarnessReport } from "./types";

export const semanticHarnessReport = (report: Omit<DevHarnessReport, "semanticHash">) => ({
  label: report.label,
  identity: {
    datasetId: report.manifest.datasetId,
    datasetVersion: report.manifest.datasetVersion,
    datasetHash: report.manifest.datasetHash,
    evaluationContractVersion: report.manifest.evaluationContractVersion,
    sourceCommit: report.manifest.sourceCommit,
    executionProvider: report.manifest.executionProvider,
    runtimeMode: report.manifest.runtimeMode,
    enabledTools: report.manifest.enabledTools,
    modelConfiguration: report.manifest.modelConfiguration,
  },
  cases: report.cases.map((item) => ({
    caseId: item.caseId,
    category: item.category,
    difficulty: item.difficulty,
    execution: item.execution,
    normalizedPrediction: item.normalizedPrediction ? {
      ...item.normalizedPrediction,
      durationMs: undefined,
    } : null,
    scoring: {
      ...item.scoring,
      cost: { ...item.scoring.cost, durationMs: undefined },
    },
  })),
  aggregate: report.aggregate,
  breakdown: report.breakdown,
});

export const calculateHarnessSemanticHash = (
  report: Omit<DevHarnessReport, "semanticHash">,
) => sha256(canonicalJson(semanticHarnessReport(report)));

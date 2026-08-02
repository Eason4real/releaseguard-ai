import type { LivePreflightFixture } from "./types";

const release = {
  id: "REL-901",
  version: "test-only-1",
  platform: "Web",
  releasedAt: "2031-01-01T09:00:00.000Z",
  rolloutStatus: "FULL",
  rolloutPercentage: 100,
  featureFlags: ["receipt_test_only"],
  changedModules: ["ReceiptRenderer"],
  provenance: "preflight_fixture",
  createdAt: "2031-01-01T08:00:00.000Z",
};

const fixture: LivePreflightFixture = {
  caseId: "CASE-901",
  executionPurpose: "PREFLIGHT_ONLY",
  benchmarkEligible: false,
  request: {
    agentInput: {
      incidentId: "INC-901",
      incidentQuestion: "Why did receipt rendering change after the test-only release?",
      riskEvent: {
        id: "RISK-901",
        correlatedReleaseId: release.id,
        metricKey: "receipt_render_success_rate",
        status: "OPEN",
        direction: "DOWN",
        filters: { platform: "Web" },
        segmentSignature: "platform=Web",
        detectedAt: "2031-01-01T11:00:00.000Z",
        firstBreachedAt: "2031-01-01T10:00:00.000Z",
        lastBreachedAt: "2031-01-01T11:00:00.000Z",
        observedValue: 0.7,
        baselineValue: 0.95,
        absoluteDeviation: -0.25,
        relativeDeviation: -0.25 / 0.95,
        sampleSize: 1_200,
        thresholdPct: 0.1,
        minSampleSize: 500,
        requiredConsecutiveBuckets: 3,
        triggerBucketIds: ["MB-901-001", "MB-901-002", "MB-901-003"],
        baselineMethod: "RECENT_MEDIAN",
        baselinePointCount: 12,
        triggerSignature: "risk:901",
        provenance: "preflight_fixture",
        createdAt: "2031-01-01T11:00:00.000Z",
        updatedAt: "2031-01-01T11:00:00.000Z",
      },
      release,
      dataSources: [{ kind: "release", sourceRef: "fixture://SRC-14021" }],
    },
    enabledTools: [
      "get_release",
      "query_metric",
      "segment_metric",
      "search_user_feedback",
      "search_similar_incidents",
    ],
    observations: [{
      evidenceId: "EV-14030",
      sourceRef: "fixture://SRC-14021",
      toolName: "get_release",
      observationScope: "CURRENT_INCIDENT",
      status: "SUCCESS",
      selector: { releaseId: release.id },
      output: {
        schema_version: "1",
        data: {
          id: release.id,
          version: release.version,
          platform: release.platform,
          changed_modules: [...release.changedModules],
        },
      },
    }],
  },
};

export const loadLivePreflightFixture = (): LivePreflightFixture => structuredClone(fixture);

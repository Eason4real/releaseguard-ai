import type { AnalyticsStore } from "../analytics/store";
import {
  MemoryAnalyticsStore,
  ensureAndroid730RiskEvent,
} from "../fixtures/android-730";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";
import { runAgentLoop } from "./agent-loop";
import { DeterministicInvestigationPlanner } from "./deterministic-planner";
import { isPhase3Store } from "./phase3-store";
import {
  executeAndRecordTool,
  finalizeInvestigation,
  fixtureDiagnosis,
  startInvestigation,
} from "./runtime";
import type { InvestigationStore } from "./store";

export async function runFixtureInvestigation(
  store: InvestigationStore,
  question: string,
  analytics: AnalyticsStore = new MemoryAnalyticsStore(),
  retrievers?: {
    feedbackRetriever?: FeedbackRetriever;
    incidentRetriever?: IncidentRetriever;
  },
) {
  const runtimeAnalytics =
    (store as InvestigationStore & { analytics?: AnalyticsStore }).analytics ?? analytics;
  const { event, release } = await ensureAndroid730RiskEvent(runtimeAnalytics);
  const runId = await startInvestigation(store, {
    question,
    provider: "安全演示",
    model: "android-7.3.0-fixture",
    incidentId: event.id,
    riskEventId: event.id,
    releaseId: release.id,
  });
  if (isPhase3Store(store)) {
    const aggregate = await runAgentLoop(store, {
      runId,
      planner: new DeterministicInvestigationPlanner(),
      analytics: runtimeAnalytics,
      trigger: "INITIAL",
      feedbackRetriever: retrievers?.feedbackRetriever,
      incidentRetriever: retrievers?.incidentRetriever,
    });
    if (!aggregate) throw new Error("Fixture InvestigationRun could not be reloaded");
    return aggregate;
  }
  const calls = [
    ["get_release", { release_id: release.id }],
    ["query_metric", {
      metric_key: event.metricKey,
      start_time: event.firstBreachedAt,
      end_time: event.lastBreachedAt,
      filters: event.filters,
      granularity_minutes: 5,
      include_baseline: true,
    }],
    ["segment_metric", {
      metric_key: event.metricKey,
      start_time: event.firstBreachedAt,
      end_time: event.lastBreachedAt,
      filters: { platform: "Android" },
      dimension: "app_version",
      limit: 10,
    }],
    ["search_user_feedback", { keyword: "优惠券 超时 Android 7.3.0" }],
    ["search_similar_incidents", { symptom: "优惠券领取失败 重试 幂等" }],
  ] as const;
  let evidenceCount = 0;
  for (let index = 0; index < calls.length; index += 1) {
    const recorded = await executeAndRecordTool(store, {
      runId,
      name: calls[index][0],
      args: calls[index][1],
      iteration: 1,
      order: index + 1,
      analytics: runtimeAnalytics,
    });
    evidenceCount += recorded.evidence.length;
  }
  await finalizeInvestigation(store, {
    runId,
    diagnosis: fixtureDiagnosis(),
    totalTokens: 0,
    evidenceCount,
  });
  const aggregate = await store.getAggregate(runId);
  if (!aggregate) throw new Error("Fixture InvestigationRun could not be reloaded");
  return aggregate;
}

import type { AnalyticsStore } from "../analytics/store";
import {
  MemoryAnalyticsStore,
  ensureAndroid730RiskEvent,
} from "../fixtures/android-730";
import type { FeedbackRetriever, IncidentRetriever } from "../retrieval/types";
import { runAgentLoop } from "./agent-loop";
import { DeterministicInvestigationPlanner } from "./deterministic-planner";
import type { Phase3InvestigationStore } from "./phase3-store";
import {
  startInvestigation,
} from "./runtime";

export async function runFixtureInvestigation(
  store: Phase3InvestigationStore,
  question: string,
  analytics: AnalyticsStore = new MemoryAnalyticsStore(),
  retrievers?: {
    feedbackRetriever?: FeedbackRetriever;
    incidentRetriever?: IncidentRetriever;
  },
) {
  const runtimeAnalytics =
    (store as Phase3InvestigationStore & { analytics?: AnalyticsStore }).analytics ?? analytics;
  const { event, release } = await ensureAndroid730RiskEvent(runtimeAnalytics);
  const runId = await startInvestigation(store, {
    question,
    provider: "安全演示",
    model: "android-7.3.0-fixture",
    incidentId: event.id,
    riskEventId: event.id,
    releaseId: release.id,
  });
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

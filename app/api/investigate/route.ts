import {
  type ModelConfig,
} from "@/lib/investigation/model";
import { LLMInvestigationPlanner } from "@/lib/investigation/llm-planner";
import { runAgentLoop } from "@/lib/investigation/agent-loop";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import {
  markInvestigationFailed,
  startInvestigation,
  toLegacyResponse,
} from "@/lib/investigation/runtime";
import { runFixtureInvestigation } from "@/lib/investigation/fixture-runtime";
import { D1AnalyticsStore } from "@/lib/analytics/repository";
import type { AnalyticsStore } from "@/lib/analytics/store";
import { ensureAndroid730RiskEvent } from "@/lib/fixtures/android-730";
import { createRuntimeRetrievers } from "@/lib/retrieval/runtime";
import type { Phase3InvestigationStore } from "@/lib/investigation/phase3-store";
import type { FeedbackRetriever, IncidentRetriever } from "@/lib/retrieval/types";
import {
  ModelCallBudgetConfigurationError,
  resolveMaxModelCalls,
} from "@/lib/investigation/model-call-budget";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

type RequestPayload = {
  question?: string;
  fixture?: boolean;
  maxModelCalls?: number;
  config?: Partial<ModelConfig>;
};

export async function GET(request: Request) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    const runId = new URL(request.url).searchParams.get("runId");
    const store = new D1InvestigationStore();
    const aggregate = runId
      ? await store.getAggregate(runId)
      : await store.getLatestAggregate();
    if (!aggregate) {
      return Response.json({ code: "RUN_NOT_FOUND", error: "还没有持久化的调查记录。" }, { status: 404 });
    }
    return Response.json(toLegacyResponse(aggregate, {
      mode: aggregate.run.model === "android-7.3.0-fixture" ? "fixture" : "live",
      parseStatus: aggregate.run.model === "android-7.3.0-fixture" ? "fixture" : "direct",
    }));
  } catch (error) {
    return Response.json(
      { code: "RUN_READ_FAILED", error: error instanceof Error ? error.message : "读取调查记录失败。" },
      { status: 500 },
    );
  }
}

type InvestigatePostDependencies = {
  store?: Phase3InvestigationStore;
  analytics?: AnalyticsStore;
  createRetrievers?: () => Promise<{
    feedbackRetriever: FeedbackRetriever;
    incidentRetriever: IncidentRetriever;
  }>;
};

export async function handleInvestigatePost(
  request: Request,
  dependencies: InvestigatePostDependencies = {},
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  const store = dependencies.store ?? new D1InvestigationStore();
  const analytics = dependencies.analytics ?? new D1AnalyticsStore();
  const retrieverFactory = dependencies.createRetrievers ?? createRuntimeRetrievers;
  let secretToRedact = "";
  let runId: string | null = null;
  try {
    const payload = await request.json() as RequestPayload;
    const question = payload.question?.trim();
    if (!question || question.length > 1000) {
      return Response.json({ error: "调查问题不能为空且不能超过 1000 字。" }, { status: 400 });
    }
    const maxModelCalls = resolveMaxModelCalls(payload.maxModelCalls);

    if (payload.fixture) {
      const retrievers = await retrieverFactory();
      const aggregate = await runFixtureInvestigation(store, question, analytics, retrievers);
      return Response.json(toLegacyResponse(aggregate, {
        mode: "fixture",
        parseStatus: "fixture",
      }));
    }

    const hostedKey = process.env.DEEPSEEK_API_KEY?.trim();
    const config: ModelConfig = {
      provider: payload.config?.provider?.trim() || (hostedKey ? "DeepSeek" : ""),
      baseUrl: payload.config?.baseUrl?.trim() || (hostedKey ? "https://api.deepseek.com" : ""),
      model: payload.config?.model?.trim() || (hostedKey ? "deepseek-v4-pro" : ""),
      apiKey: payload.config?.apiKey?.trim() || hostedKey || "",
    };
    secretToRedact = config.apiKey;
    if (!config.provider || !config.baseUrl || !config.model || !config.apiKey) {
      return Response.json(
        { code: "MODEL_NOT_CONFIGURED", error: "请先配置模型服务、Base URL、Model ID 和 API Key。" },
        { status: 503 },
      );
    }
    if (config.provider.length > 60 || config.baseUrl.length > 500 || config.model.length > 120 || config.apiKey.length > 2000) {
      return Response.json({ error: "模型配置字段长度超出限制。" }, { status: 400 });
    }

    const { event, release } = await ensureAndroid730RiskEvent(analytics);
    runId = await startInvestigation(store, {
      question,
      provider: config.provider,
      model: config.model,
      incidentId: event.id,
      riskEventId: event.id,
      releaseId: release.id,
      maxModelCalls,
    });
    const retrievers = await retrieverFactory();
    const aggregate = await runAgentLoop(store, {
      runId,
      planner: new LLMInvestigationPlanner(config, { maxDecisionRepairAttempts: 2 }),
      analytics,
      trigger: "INITIAL",
      feedbackRetriever: retrievers.feedbackRetriever,
      incidentRetriever: retrievers.incidentRetriever,
      signal: request.signal,
    });
    if (!aggregate) throw new Error("调查完成，但运行记录读取失败。");
    return Response.json(toLegacyResponse(aggregate, {
      mode: "live",
      parseStatus: "direct",
    }));
  } catch (error) {
    if (error instanceof ModelCallBudgetConfigurationError) {
      return Response.json({ code: error.code, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "未知错误";
    const redacted = secretToRedact ? message.replaceAll(secretToRedact, "[redacted]") : message;
    const safeMessage = redacted.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]");
    if (runId) {
      try {
        await markInvestigationFailed(store, runId, safeMessage);
      } catch {
        // Return the original failure even if failure-state persistence also fails.
      }
    }
    return Response.json(
      { code: "INVESTIGATION_FAILED", runId, error: safeMessage },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  return handleInvestigatePost(request);
}

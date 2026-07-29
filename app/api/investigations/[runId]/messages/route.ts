import { D1AnalyticsStore } from "@/lib/analytics/repository";
import { InvestigationChatError, submitInvestigationMessage } from "@/lib/investigation/chat-runtime";
import { DeterministicInvestigationPlanner } from "@/lib/investigation/deterministic-planner";
import { LLMInvestigationPlanner } from "@/lib/investigation/llm-planner";
import type { ModelConfig } from "@/lib/investigation/model";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { toLegacyResponse } from "@/lib/investigation/runtime";
import type { InvestigationMessageIntent } from "@/lib/investigation/types";
import { createRuntimeRetrievers } from "@/lib/retrieval/runtime";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    const { runId } = await context.params;
    const body = await request.json() as {
      clientRequestId?: string;
      intent?: InvestigationMessageIntent;
      content?: string;
      citedEvidenceIds?: string[];
      config?: Partial<ModelConfig>;
    };
    if (!body.clientRequestId?.trim() || !body.intent || !body.content?.trim()) {
      return Response.json({ code: "MESSAGE_INVALID", error: "消息参数不完整。" }, { status: 400 });
    }
    const store = new D1InvestigationStore();
    const aggregate = await store.getAggregate(runId);
    if (!aggregate) {
      return Response.json({ code: "RUN_NOT_FOUND", error: "调查不存在。" }, { status: 404 });
    }
    let planner;
    if (body.intent !== "EXPLAIN") {
      if (aggregate.run.plannerType === "DETERMINISTIC") {
        planner = new DeterministicInvestigationPlanner();
      } else {
        const hostedKey = process.env.DEEPSEEK_API_KEY?.trim();
        const config: ModelConfig = {
          provider: body.config?.provider?.trim() || (hostedKey ? "DeepSeek" : ""),
          baseUrl: body.config?.baseUrl?.trim() || (hostedKey ? "https://api.deepseek.com" : ""),
          model: body.config?.model?.trim() || aggregate.run.model,
          apiKey: body.config?.apiKey?.trim() || hostedKey || "",
        };
        if (!config.provider || !config.baseUrl || !config.model || !config.apiKey) {
          return Response.json({ code: "MODEL_NOT_CONFIGURED", error: "继续调查前请配置模型服务。" }, { status: 503 });
        }
        planner = new LLMInvestigationPlanner(config);
      }
    }
    const retrievers = await createRuntimeRetrievers();
    const result = await submitInvestigationMessage(store, {
      runId,
      clientRequestId: body.clientRequestId.trim(),
      intent: body.intent,
      content: body.content,
      citedEvidenceIds: body.citedEvidenceIds,
      planner,
      analytics: new D1AnalyticsStore(),
      feedbackRetriever: retrievers.feedbackRetriever,
      incidentRetriever: retrievers.incidentRetriever,
      signal: request.signal,
    });
    if (!result) throw new Error("消息处理后无法恢复 Run。");
    return Response.json(toLegacyResponse(result, {
      mode: result.run.plannerType === "DETERMINISTIC" ? "fixture" : "live",
      parseStatus: result.run.plannerType === "DETERMINISTIC" ? "fixture" : "direct",
    }));
  } catch (error) {
    if (error instanceof InvestigationChatError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({
      code: "MESSAGE_FAILED",
      error: error instanceof Error ? error.message : "消息处理失败。",
    }, { status: 500 });
  }
}

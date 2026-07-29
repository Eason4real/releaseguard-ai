import { D1InvestigationStore } from "@/lib/investigation/repository";
import { continueInvestigation } from "@/lib/investigation/revision-runtime";
import { RuntimeRequestError } from "@/lib/investigation/action-runtime";
import { toLegacyResponse } from "@/lib/investigation/runtime";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    const { runId } = await context.params;
    const body = await request.json() as { clientRequestId?: string; reason?: string };
    if (!body.clientRequestId?.trim()) {
      return Response.json({ code: "CLIENT_REQUEST_ID_REQUIRED", error: "缺少幂等请求 ID。" }, { status: 400 });
    }
    const aggregate = await continueInvestigation(new D1InvestigationStore(), {
      runId,
      clientRequestId: body.clientRequestId.trim(),
      reason: body.reason,
    });
    if (!aggregate) throw new Error("继续调查后无法恢复 Run。");
    return Response.json(toLegacyResponse(aggregate, {
      mode: aggregate.run.plannerType === "DETERMINISTIC" ? "fixture" : "live",
      parseStatus: aggregate.run.plannerType === "DETERMINISTIC" ? "fixture" : "direct",
    }));
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({
      code: "CONTINUE_INVESTIGATION_FAILED",
      error: error instanceof Error ? error.message : "继续调查失败。",
    }, { status: 500 });
  }
}

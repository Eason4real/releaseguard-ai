import {
  decideProposedAction,
  RuntimeRequestError,
} from "@/lib/investigation/action-runtime";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { toLegacyResponse } from "@/lib/investigation/runtime";

type ApprovalRequest = {
  runId?: string;
  proposedActionId?: string;
  decision?: "APPROVE" | "REJECT";
  reason?: string | null;
  target?: {
    owner?: string | null;
    repo?: string | null;
  };
};

export async function POST(request: Request) {
  let payload: ApprovalRequest;
  try {
    payload = await request.json() as ApprovalRequest;
  } catch {
    return Response.json({ code: "INVALID_JSON", error: "请求格式不正确。" }, { status: 400 });
  }

  const runId = payload.runId?.trim();
  const proposedActionId = payload.proposedActionId?.trim();
  if (
    !runId
    || !proposedActionId
    || (payload.decision !== "APPROVE" && payload.decision !== "REJECT")
  ) {
    return Response.json({
      code: "APPROVAL_REQUEST_INVALID",
      error: "必须提供 runId、proposedActionId 和有效审批决定。",
    }, { status: 400 });
  }

  try {
    const aggregate = await decideProposedAction(new D1InvestigationStore(), {
      runId,
      proposedActionId,
      decision: payload.decision,
      reason: payload.reason,
      targetOwner: payload.target?.owner,
      targetRepo: payload.target?.repo,
    });
    return Response.json(toLegacyResponse(aggregate, {
      mode: aggregate.run.model === "android-7.3.0-fixture" ? "fixture" : "live",
      parseStatus: aggregate.run.model === "android-7.3.0-fixture" ? "fixture" : "direct",
    }));
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({
      code: "APPROVAL_FAILED",
      error: error instanceof Error ? error.message : "审批失败。",
    }, { status: 500 });
  }
}

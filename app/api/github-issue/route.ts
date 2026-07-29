import {
  executeApprovedGithubAction,
  RuntimeRequestError,
} from "@/lib/investigation/action-runtime";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

type GithubRequest = {
  runId?: string;
  proposedActionId?: string;
  config?: {
    token?: string;
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export async function POST(request: Request) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  let payload: GithubRequest;
  try {
    payload = await request.json() as GithubRequest;
  } catch {
    return json({ code: "INVALID_JSON", error: "请求格式不正确。" }, 400);
  }

  const runId = payload.runId?.trim();
  const proposedActionId = payload.proposedActionId?.trim();
  const token = payload.config?.token?.trim();
  if (!runId || !proposedActionId || !token) {
    return json({
      code: "ACTION_REFERENCE_REQUIRED",
      error: "必须提供 runId、proposedActionId 和 GitHub 访问令牌。",
    }, 400);
  }

  try {
    const output = await executeApprovedGithubAction(
      new D1InvestigationStore(),
      { runId, proposedActionId, token },
    );
    return json(output);
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return json({ code: error.code, error: error.message }, error.status);
    }
    return json({
      code: "ACTION_EXECUTION_FAILED",
      error: error instanceof Error ? error.message : "GitHub Action 执行失败。",
    }, 500);
  }
}

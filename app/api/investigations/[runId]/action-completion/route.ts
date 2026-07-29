import { RuntimeRequestError } from "@/lib/investigation/action-runtime";
import type { Phase4InvestigationStore } from "@/lib/investigation/phase4-store";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { confirmActionCompletion } from "@/lib/investigation/verification-runtime";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

type ActionCompletionRequest = {
  clientRequestId?: string;
  effectiveAt?: string;
  changeReference?: string;
  note?: string | null;
};

export async function handleActionCompletionPost(
  request: Request,
  runId: string,
  store: Phase4InvestigationStore = new D1InvestigationStore(),
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    const body = await request.json() as ActionCompletionRequest;
    if (
      !body.clientRequestId?.trim()
      || !body.effectiveAt?.trim()
      || !body.changeReference?.trim()
    ) {
      return Response.json({
        code: "ACTION_COMPLETION_INPUT_REQUIRED",
        error: "必须提供 clientRequestId、effectiveAt 和 changeReference。",
      }, { status: 400 });
    }
    const completion = await confirmActionCompletion(store, {
      runId,
      clientRequestId: body.clientRequestId,
      effectiveAt: body.effectiveAt,
      changeReference: body.changeReference,
      note: body.note,
    });
    return Response.json({ actionCompletion: completion });
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({
      code: "ACTION_COMPLETION_FAILED",
      error: error instanceof Error ? error.message : "Action completion 失败。",
    }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  const { runId } = await context.params;
  return handleActionCompletionPost(request, runId);
}

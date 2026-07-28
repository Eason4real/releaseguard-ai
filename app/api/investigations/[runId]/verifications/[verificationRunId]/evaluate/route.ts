import { RuntimeRequestError } from "@/lib/investigation/action-runtime";
import type { Phase4InvestigationStore } from "@/lib/investigation/phase4-store";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { evaluateVerificationAttempt } from "@/lib/investigation/verification-runtime";

export async function handleVerificationEvaluatePost(
  request: Request,
  runId: string,
  verificationRunId: string,
  store: Phase4InvestigationStore = new D1InvestigationStore(),
  clock: () => Date = () => new Date(),
) {
  try {
    const body = await request.json() as { clientRequestId?: string };
    if (!body.clientRequestId?.trim()) {
      return Response.json({ code: "CLIENT_REQUEST_ID_REQUIRED", error: "必须提供 clientRequestId。" }, { status: 400 });
    }
    return Response.json(await evaluateVerificationAttempt(store, {
      runId, verificationRunId, clientRequestId: body.clientRequestId,
    }, clock));
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({ code: "VERIFICATION_EVALUATION_FAILED", error: "Verification evaluation 失败。" }, { status: 500 });
  }
}

export async function POST(request: Request, context: {
  params: Promise<{ runId: string; verificationRunId: string }>;
}) {
  const { runId, verificationRunId } = await context.params;
  return handleVerificationEvaluatePost(request, runId, verificationRunId);
}

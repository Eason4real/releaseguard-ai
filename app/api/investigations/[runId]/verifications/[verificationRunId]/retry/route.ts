import { RuntimeRequestError } from "@/lib/investigation/action-runtime";
import type { Phase4InvestigationStore } from "@/lib/investigation/phase4-store";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { retryVerificationAttempt } from "@/lib/investigation/verification-runtime";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

export async function handleVerificationRetryPost(
  request: Request, runId: string, verificationRunId: string,
  store: Phase4InvestigationStore = new D1InvestigationStore(),
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    const body = await request.json() as { clientRequestId?: string };
    if (!body.clientRequestId?.trim()) {
      return Response.json({ code: "CLIENT_REQUEST_ID_REQUIRED", error: "必须提供 clientRequestId。" }, { status: 400 });
    }
    return Response.json(await retryVerificationAttempt(store, {
      runId, verificationRunId, clientRequestId: body.clientRequestId,
    }));
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({ code: "VERIFICATION_RETRY_FAILED", error: "Verification retry 失败。" }, { status: 500 });
  }
}

export async function POST(request: Request, context: {
  params: Promise<{ runId: string; verificationRunId: string }>;
}) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  const { runId, verificationRunId } = await context.params;
  return handleVerificationRetryPost(request, runId, verificationRunId);
}

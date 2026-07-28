import { RuntimeRequestError } from "@/lib/investigation/action-runtime";
import type { Phase4InvestigationStore } from "@/lib/investigation/phase4-store";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import { reopenAfterVerification } from "@/lib/investigation/verification-runtime";

export async function handleVerificationReopenPost(
  request: Request, runId: string, verificationRunId: string,
  store: Phase4InvestigationStore = new D1InvestigationStore(),
) {
  try {
    const body = await request.json() as { clientRequestId?: string; reason?: string | null };
    if (!body.clientRequestId?.trim()) {
      return Response.json({ code: "CLIENT_REQUEST_ID_REQUIRED", error: "必须提供 clientRequestId。" }, { status: 400 });
    }
    return Response.json(await reopenAfterVerification(store, {
      runId, verificationRunId, clientRequestId: body.clientRequestId, reason: body.reason,
    }));
  } catch (error) {
    if (error instanceof RuntimeRequestError) {
      return Response.json({ code: error.code, error: error.message }, { status: error.status });
    }
    return Response.json({ code: "VERIFICATION_REOPEN_FAILED", error: "Verification reopen 失败。" }, { status: 500 });
  }
}

export async function POST(request: Request, context: {
  params: Promise<{ runId: string; verificationRunId: string }>;
}) {
  const { runId, verificationRunId } = await context.params;
  return handleVerificationReopenPost(request, runId, verificationRunId);
}

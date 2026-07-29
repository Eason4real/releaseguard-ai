import { RuntimeRequestError } from "@/lib/investigation/action-runtime";
import type { Phase4InvestigationStore } from "@/lib/investigation/phase4-store";
import { D1InvestigationStore } from "@/lib/investigation/repository";
import {
  createVerificationAttempt,
  listVerificationHistory,
} from "@/lib/investigation/verification-runtime";
import { blockPublicDemoOperation } from "@/lib/deployment-mode";

type VerificationRequest = { clientRequestId?: string };

const errorResponse = (error: unknown) => {
  if (error instanceof RuntimeRequestError) {
    return Response.json({ code: error.code, error: error.message }, { status: error.status });
  }
  return Response.json({
    code: "VERIFICATION_RUNTIME_FAILED",
    error: error instanceof Error ? error.message : "Verification Runtime 失败。",
  }, { status: 500 });
};

export async function handleVerificationPost(
  request: Request,
  runId: string,
  store: Phase4InvestigationStore = new D1InvestigationStore(),
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    const body = await request.json() as VerificationRequest;
    if (!body.clientRequestId?.trim()) {
      return Response.json({
        code: "CLIENT_REQUEST_ID_REQUIRED",
        error: "必须提供 clientRequestId。",
      }, { status: 400 });
    }
    return Response.json(await createVerificationAttempt(store, {
      runId,
      clientRequestId: body.clientRequestId,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleVerificationGet(
  runId: string,
  store: Phase4InvestigationStore = new D1InvestigationStore(),
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  try {
    return Response.json({ verifications: await listVerificationHistory(store, runId) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  const { runId } = await context.params;
  return handleVerificationPost(request, runId);
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const blocked = blockPublicDemoOperation();
  if (blocked) return blocked;
  const { runId } = await context.params;
  return handleVerificationGet(runId);
}

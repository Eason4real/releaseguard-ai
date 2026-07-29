import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canApplyInvestigationResponse,
  canPresentCurrentInvestigation,
  presentationStatusFromRun,
  resolveActionPresentation,
  resolveAuditEventLabel,
  resolveInvestigationConfidence,
  resolvePlannerUsagePresentation,
  resolveSuccessfulGithubIssue,
} from "../lib/investigation/ui-presentation";
import type { InvestigationAggregate, LegacyInvestigationResponse } from "../lib/investigation/types";

const pageSource = () => readFile("app/page.tsx", "utf8");

test("Phase 4 UI renders claim evidence and marks historical RAG provenance", async () => {
  const source = await pageSource();
  assert.match(source, /diagnosisClaimEvidenceLinks/);
  assert.match(source, /Evidence 引用/);
  assert.match(source, /Historical Memory \/ RAG/);
  assert.match(source, /Supporting Evidence/);
  assert.match(source, /Contradicting Evidence/);
  assert.match(source, /Neutral Evidence/);
});

test("Phase 4 UI renders deterministic verification outcomes and policy evidence", async () => {
  const source = await pageSource();
  assert.match(source, /verificationPolicySnapshots/);
  assert.match(source, /verificationEvaluations/);
  assert.match(source, /requiredConsecutiveBuckets/);
  for (const outcome of ["RESOLVED", "PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"]) {
    assert.match(source, new RegExp(outcome));
  }
});

test("Phase 4 UI suppresses retry and reopen controls for stale, failed and resolved attempts", async () => {
  const source = await pageSource();
  assert.match(source, /const stale = latest\.attempt !== Math\.max/);
  assert.match(source, /const canRetry = !stale/);
  assert.match(source, /latest\.status !== "FAILED"/);
  assert.match(source, /latest\.status !== "RESOLVED"/);
});

test("Phase 4 UI truthfully labels fixture, live, fallback and approved GitHub writes", async () => {
  const source = await pageSource();
  assert.match(source, /FIXTURE/);
  assert.match(source, /FALLBACK/);
  assert.match(source, /REAL WRITE/);
  assert.match(source, /OpenAI-compatible LLM/);
  assert.match(source, /尚未确认修复上线/);
  assert.doesNotMatch(source, /自动修复|自动部署|实时生产数据/);
});

const investigationWithConfidence = (confidence: "LOW" | "MEDIUM" | "HIGH") => ({
  runId: "RUN-current",
  runStatus: "WAITING_APPROVAL",
  investigation: {
    run: { status: "WAITING_APPROVAL", errorMessage: null },
    diagnosis: { selectedHypothesisId: "HYP-current", supersededAt: null },
    hypotheses: [{ id: "HYP-current", status: "SUPPORTED", confidence }],
  },
}) as unknown as LegacyInvestigationResponse;

test("Investigation confidence is unavailable before, during and after a failed current run", () => {
  const stale = investigationWithConfidence("HIGH");
  assert.deepEqual(resolveInvestigationConfidence("idle", null), { confidence: null, label: "待调查" });
  assert.deepEqual(resolveInvestigationConfidence("running", stale), { confidence: null, label: "调查中" });
  assert.deepEqual(resolveInvestigationConfidence("error", stale), { confidence: null, label: "不可用" });
  assert.deepEqual(resolveInvestigationConfidence("not_configured", stale),
    { confidence: null, label: "待调查" });
});

test("Investigation confidence only displays the current Diagnosis selected Hypothesis server value", () => {
  assert.deepEqual(resolveInvestigationConfidence("live", investigationWithConfidence("MEDIUM")),
    { confidence: "MEDIUM", label: "MEDIUM" });
  const withoutDiagnosis = {
    runId: "RUN-current", runStatus: "WAITING_APPROVAL",
    investigation: { run: { status: "WAITING_APPROVAL", errorMessage: null }, diagnosis: null,
      hypotheses: [{ id: "HYP-old", status: "SUPPORTED", confidence: "HIGH" }] },
  } as unknown as LegacyInvestigationResponse;
  assert.deepEqual(resolveInvestigationConfidence("live", withoutDiagnosis),
    { confidence: null, label: "暂无结论" });
  const failedWithOldDiagnosis = investigationWithConfidence("HIGH");
  failedWithOldDiagnosis.runStatus = "FAILED";
  assert.deepEqual(resolveInvestigationConfidence("live", failedWithOldDiagnosis),
    { confidence: null, label: "不可用" });
  assert.equal(canPresentCurrentInvestigation("live", failedWithOldDiagnosis, "RUN-current"), false);
});

test("Current Run binding rejects stale responses and only presents a successful active Run", () => {
  const current = investigationWithConfidence("HIGH");
  assert.equal(canApplyInvestigationResponse(1, 2, "RUN-old", "RUN-old"), false);
  assert.equal(canApplyInvestigationResponse(2, 2, "RUN-current", "RUN-old"), false);
  assert.equal(canApplyInvestigationResponse(2, 2, null, "RUN-current"), true);
  assert.equal(canPresentCurrentInvestigation("live", current, "RUN-old"), false);
  assert.deepEqual(resolveInvestigationConfidence("live", current, "RUN-old"),
    { confidence: null, label: "待调查" });
  assert.equal(canPresentCurrentInvestigation("live", current, "RUN-current"), true);
  assert.deepEqual(resolveInvestigationConfidence("live", current, "RUN-current"),
    { confidence: "HIGH", label: "HIGH" });
});

test("Server PENDING, RUNNING, and FAILED states override cached Diagnosis confidence", () => {
  for (const runStatus of ["PENDING", "RUNNING"] as const) {
    const pending = investigationWithConfidence("HIGH");
    pending.runStatus = runStatus;
    assert.equal(presentationStatusFromRun(pending), "running");
    assert.deepEqual(resolveInvestigationConfidence("live", pending, "RUN-current"),
      { confidence: null, label: "调查中" });
  }
  const failed = investigationWithConfidence("HIGH");
  failed.runStatus = "FAILED";
  assert.equal(presentationStatusFromRun(failed), "error");
  assert.deepEqual(resolveInvestigationConfidence("live", failed, "RUN-current"),
    { confidence: null, label: "不可用" });
});

test("Starting a new Web investigation clears stale artifacts and guards concurrent responses", async () => {
  const source = await pageSource();
  assert.match(source, /const requestId = \+\+investigationRequest\.current/);
  assert.match(source,
    /useEffect\(\(\) => \{\s*const requestGeneration = \+\+investigationRequest\.current;\s*let active = true/);
  assert.match(source,
    /savedWorkflow && active && requestGeneration === investigationRequest\.current/);
  assert.match(source, /acceptInvestigationResponse\(persisted, requestGeneration, savedRunId\)/);
  assert.match(source, /currentRunIdRef\.current = null/);
  assert.match(source, /window\.sessionStorage\.removeItem\("releaseguard:run-id"\);\s*setInvestigationStatus\("running"\);\s*setInvestigation\(null\)/);
  assert.match(source, /if \(requestId !== investigationRequest\.current\) return;/);
  assert.match(source, /<b>调查失败<\/b>/);
  assert.doesNotMatch(source, /const confidence[^\n]*:\s*"HIGH"/);
});

test("Planner usage presentation distinguishes complete, partial and unavailable values", () => {
  assert.deepEqual(resolvePlannerUsagePresentation({
    input_tokens: 1_200,
    output_tokens: 300,
    total_tokens: 1_500,
    completeness: "COMPLETE",
    model_call_count: 2,
    usage_observed_call_count: 2,
  }), {
    input: "1,200", output: "300", total: "1,500",
    completeness: "COMPLETE", completenessLabel: "完整",
  });
  assert.equal(resolvePlannerUsagePresentation({
    input_tokens: 900,
    output_tokens: null,
    total_tokens: null,
    completeness: "PARTIAL",
    model_call_count: 2,
    usage_observed_call_count: 1,
  }).completenessLabel, "部分");
  const unavailable = resolvePlannerUsagePresentation({
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    completeness: "UNAVAILABLE",
    model_call_count: 1,
    usage_observed_call_count: 0,
  });
  assert.equal(unavailable.total, "不可用");
  assert.notEqual(unavailable.total, "0");
});

test("Audit presentation distinguishes model observation, rejection, acceptance, repair and budget", () => {
  const event = (type: InvestigationAggregate["auditEvents"][number]["type"]) => ({
    type,
  }) as InvestigationAggregate["auditEvents"][number];
  assert.deepEqual([
    "PLANNER_MODEL_CALL_OBSERVED",
    "PLANNER_DECISION_REJECTED",
    "PLANNER_DECISION_ACCEPTED",
    "PLANNER_DECISION_REPAIR_ATTEMPTED",
    "PLANNER_MODEL_CALL_BUDGET_EXHAUSTED",
  ].map((type) => resolveAuditEventLabel(event(
    type as InvestigationAggregate["auditEvents"][number]["type"],
  ))), [
    "模型响应已观测",
    "Planner decision 已拒绝",
    "Planner decision 已接受",
    "Planner decision repair 已尝试",
    "模型调用预算已耗尽",
  ]);
});

const actionAggregate = (input: {
  actionStatus: string;
  callStatus: string;
  approvalStatus?: string;
  resultStatus?: string | null;
  output?: unknown;
}) => ({
  proposedAction: { id: "PA-1", status: input.actionStatus },
  approval: { id: "APR-1", status: input.approvalStatus ?? "PENDING" },
  toolCalls: [{
    id: "TC-1",
    name: "create_github_issue",
    proposedActionId: "PA-1",
    status: input.callStatus,
    result: input.resultStatus ? {
      status: input.resultStatus,
      output: input.output ?? null,
      errorMessage: input.resultStatus === "ERROR" ? "GitHub rejected the request." : null,
    } : null,
  }],
}) as unknown as InvestigationAggregate;

test("Action presentation is derived from persisted approval, tool and result state", () => {
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "PENDING_APPROVAL", callStatus: "WAITING_APPROVAL",
  })).state, "WAITING_APPROVAL");
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "EXECUTING", callStatus: "RUNNING", approvalStatus: "APPROVED",
  })).state, "RUNNING");
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "SUCCEEDED", callStatus: "COMPLETED", approvalStatus: "APPROVED",
    resultStatus: "SUCCESS",
    output: { number: 42, title: "Release fix", url: "https://github.com/acme/repo/issues/42",
      createdAt: "2026-07-29T00:00:00.000Z" },
  })).state, "SUCCEEDED");
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "FAILED", callStatus: "COMPLETED", approvalStatus: "APPROVED",
    resultStatus: "ERROR",
  })).state, "FAILED");
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "REJECTED", callStatus: "DENIED", approvalStatus: "REJECTED",
  })).state, "REJECTED");
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "CANCELLED", callStatus: "CANCELLED", approvalStatus: "WITHDRAWN",
  })).state, "CANCELLED");
});

test("Action presentation never reports success without a completed call and valid result", () => {
  const missingResult = resolveActionPresentation(actionAggregate({
    actionStatus: "SUCCEEDED", callStatus: "COMPLETED", approvalStatus: "APPROVED",
  }));
  assert.equal(missingResult.state, "FAILED");
  assert.doesNotMatch(missingResult.title, /已创建/);
  assert.equal(resolveSuccessfulGithubIssue(actionAggregate({
    actionStatus: "SUCCEEDED", callStatus: "WAITING_APPROVAL", approvalStatus: "APPROVED",
    resultStatus: "SUCCESS",
    output: { number: 42, title: "Release fix", url: "https://github.com/acme/repo/issues/42",
      createdAt: "2026-07-29T00:00:00.000Z" },
  })), null);
  assert.equal(resolveSuccessfulGithubIssue(actionAggregate({
    actionStatus: "PENDING_APPROVAL", callStatus: "COMPLETED", approvalStatus: "PENDING",
    resultStatus: "SUCCESS",
    output: { number: 42, title: "Release fix", url: "https://github.com/acme/repo/issues/42",
      createdAt: "2026-07-29T00:00:00.000Z" },
  })), null);
});

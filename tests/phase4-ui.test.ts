import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildRuntimeAuditTimeline,
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
import {
  isHostedCorpusImportEnabled,
  isLocalSchemaAutoMigrationEnabled,
  resolveDeploymentMode,
} from "../lib/deployment-mode";
import {
  createPublicDemoReplayState,
  getPublicDemoReplaySteps,
  publicDemoReplayReducer,
  selectPublicDemoReplay,
} from "../lib/public-demo";

const pageSource = async () => [
  await readFile("app/page.tsx", "utf8"),
  await readFile("app/private-live-workspace.tsx", "utf8"),
  await readFile("app/public-demo.tsx", "utf8"),
].join("\n");

test("Deployment mode defaults safe and only an exact server value enables Private Live", () => {
  assert.equal(resolveDeploymentMode(undefined), "PUBLIC_DEMO");
  assert.equal(resolveDeploymentMode("PUBLIC_DEMO"), "PUBLIC_DEMO");
  assert.equal(resolveDeploymentMode("private_live"), "PUBLIC_DEMO");
  assert.equal(resolveDeploymentMode("PRIVATE_LIVE"), "PRIVATE_LIVE");
});

test("Runtime schema auto-migration is limited to explicit local and test execution", () => {
  assert.equal(isLocalSchemaAutoMigrationEnabled({}), false);
  assert.equal(isLocalSchemaAutoMigrationEnabled({
    NODE_ENV: "production", RELEASEGUARD_SCHEMA_MODE: "LOCAL_AUTO",
  }), false);
  assert.equal(isLocalSchemaAutoMigrationEnabled({
    NODE_ENV: "development", RELEASEGUARD_SCHEMA_MODE: "LOCAL_AUTO",
  }), true);
  assert.equal(isLocalSchemaAutoMigrationEnabled({
    NODE_ENV: "test", RELEASEGUARD_SCHEMA_MODE: "LOCAL_AUTO",
  }), true);
});

test("Hosted corpus import is impossible in Public Demo even when its schedule flag is set", () => {
  assert.equal(isHostedCorpusImportEnabled("PUBLIC_DEMO", "true"), false);
  assert.equal(isHostedCorpusImportEnabled(undefined, "true"), false);
  assert.equal(isHostedCorpusImportEnabled("PRIVATE_LIVE", "false"), false);
  assert.equal(isHostedCorpusImportEnabled("PRIVATE_LIVE", "true"), true);
});

test("Public Demo completes the curated Agent replay entirely in a local state machine", () => {
  let state = createPublicDemoReplayState();
  for (let remaining = getPublicDemoReplaySteps("NORMAL").length; remaining > 0; remaining -= 1) {
    state = publicDemoReplayReducer(state, { type: "NEXT" });
  }
  assert.equal(selectPublicDemoReplay(state).stage, "VERIFIED");
  assert.equal(selectPublicDemoReplay(state).auditEvents.length > 20, true);
  state = publicDemoReplayReducer(state, { type: "RESET" });
  assert.equal(selectPublicDemoReplay(state).stage, "IDLE");
});

test("Public Demo UI has no persistence, credential fields, network calls or real issue links", async () => {
  const source = await readFile("app/public-demo.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  assert.doesNotMatch(source, /fetch\(|sessionStorage|localStorage|apiKey|type=["']password|github\.com|<input/i);
  assert.match(source, /Agent 调查回放/);
  assert.match(source, /故障注入回放/);
  assert.match(source, /模拟工作项已创建|模拟创建本地工作项/);
  assert.match(source, /Action Completion/);
  assert.match(source, /Verification/);
  assert.match(source, /不调用真实模型、GitHub 或 D1/);
  assert.doesNotMatch(styles, /\.replay-command-button\.reset[^\{]*\{[^\}]*display\s*:\s*none/);
});

test("Public Demo presents a business-first risk investigation workbench", async () => {
  const source = await readFile("app/public-demo.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");

  for (const text of [
    "风险调查工作台",
    "风险事件摘要",
    "为什么进入调查？",
    "当前调查进度",
    "当前调查方向",
    "AI 找到了什么？",
    "下一步",
    "业务指标监控",
    "触发业务团队预设风险规则",
    "暂时不需要你操作",
    "需要负责人确认",
    "正在验证是否恢复",
    "本次风险已关闭",
  ]) assert.match(source, new RegExp(text));

  assert.match(source, /businessProgress = \["发现异常", "分析可能原因", "收集证据", "形成结论", "等待决策", "验证恢复"\]/);
  assert.match(source, /InvestigationView = "workspace" \| "technical"/);
  assert.match(source, /查看 Agent 技术执行详情/);
  assert.match(source, /返回风险调查工作台/);
  assert.match(source, /真实环境中这些步骤会自动执行，用户只需在关键决策点介入/);
  assert.match(source, /真实工作区会复用既有审批流程/);
  assert.match(source, /查看审批后的验证示例/);
  assert.match(source, /dispatch\(\{ type: "NEXT" \}\);\s*dispatch\(\{ type: "NEXT" \}\);/);
  assert.match(source, /调查方向正在生成中…/);
  assert.match(source, /正在收集证据…/);
  assert.match(source, /snapshot\.evidence\.map/);
  assert.doesNotMatch(source, /supportedEvidence|contradictingEvidence/);
  assert.match(source, /RISK_DETECTED: "发现风险异常"/);
  assert.match(source, /CREATE_HYPOTHESES: "生成调查方向"/);
  assert.match(source, /get_release: "检查版本发布记录"/);
  assert.match(source, /\{event\.kind\}<small>\{auditSourceLabels\[event\.source\]\} · \{event\.source\}/);
  assert.match(source, /当前为另一个完整演示案例，用于展示 Agent 的真实调查过程/);
  const replayNav = source.indexOf("navigation.slice(0, 2)");
  const bestPracticeNav = source.indexOf('data-testid="best-practice-entry"');
  const technicalNav = source.indexOf("navigation.slice(2)");
  assert.ok(replayNav < bestPracticeNav && bestPracticeNav < technicalNav);
  assert.match(styles, /\.risk-workbench/);
  assert.match(styles, /\.risk-evidence-list/);
  assert.match(styles, /\.technical-replay-toolbar/);
  assert.doesNotMatch(source, /id: "replay", label: "Agent 执行详情"/);
});

test("Guided Experience keeps detailed rationale behind concise business summaries", async () => {
  const guided = await readFile("app/guided-experience/guided-experience.tsx", "utf8");
  const scenario = await readFile("lib/best-practice-scenario.ts", "utf8");
  const publicDemo = await readFile("app/public-demo.tsx", "utf8");

  assert.match(guided, /新版发布\{scenario\.after\.elapsed\}后，酒店下单转化率出现明显异常/);
  assert.match(guided, /hypothesis\.priority/);
  assert.match(guided, /hypothesis\.summary/);
  assert.match(guided, /guided-reason-details/);
  assert.match(guided, /item\.summary/);
  assert.match(guided, /新手案例：酒店推荐策略异常 · 非生产数据/);
  assert.match(guided, /进入完整调查工作台示例/);
  assert.doesNotMatch(guided, /可能原因 \{hypothesis\.id\}/);
  for (const text of [
    "优先排查",
    "新版刚修改酒店排序，而且异常紧跟发布出现。",
    "同时排查",
    "库存/价格服务运行正常",
    "高价酒店曝光占比 31% → 52%",
    "风险标准由业务团队提前设定，AI 负责发现异常后的调查。",
  ]) assert.match(scenario, new RegExp(text));
  assert.doesNotMatch(scenario, /LLM/);
  assert.doesNotMatch(publicDemo, /不是 LLM 临时生成的/);
});

test("Public and Private workspaces are split and Private Live never silently substitutes fixture", async () => {
  const shell = await readFile("app/page.tsx", "utf8");
  const privateSource = await readFile("app/private-live-workspace.tsx", "utf8");
  assert.match(shell, /lazy\(\(\) => import\("\.\/private-live-workspace"\)\)/);
  assert.match(shell, /useState<DeploymentMode>\("PUBLIC_DEMO"\)/);
  assert.match(privateSource, /if \(!modelConfig\)/);
  assert.match(privateSource, /fixture: false/);
  assert.doesNotMatch(privateSource, /fixture: !modelConfig/);
  assert.doesNotMatch(privateSource, /Eason4real|releaseguard-demo/);
  assert.match(privateSource, /私有 Live 模式/);
});

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

const githubTimelineAggregate = (input?: {
  auditEvents?: InvestigationAggregate["auditEvents"];
  sharedLifecycleTimestamp?: string;
}) => {
  const createdAt = "2026-07-29T03:38:18.000Z";
  const claimAt = input?.sharedLifecycleTimestamp ?? "2026-07-29T03:50:26.000Z";
  const dispatchAt = input?.sharedLifecycleTimestamp ?? "2026-07-29T03:50:27.000Z";
  const succeededAt = input?.sharedLifecycleTimestamp ?? "2026-07-29T03:50:28.000Z";
  const event = (
    id: string,
    type: InvestigationAggregate["auditEvents"][number]["type"],
    at: string,
    toolCallId: string | null,
  ) => ({
    id, runId: "RUN-1", proposedActionId: "PA-1", approvalId: "APR-1",
    toolCallId, type, actor: "ReleaseGuard Action Runtime", details: {}, createdAt: at,
  }) as InvestigationAggregate["auditEvents"][number];
  const auditEvents = input && "auditEvents" in input ? input.auditEvents ?? [] : [
    event("AUD-success", "ACTION_SUCCEEDED", succeededAt, "TC-1"),
    event("AUD-created", "PROPOSED_ACTION_CREATED", createdAt, null),
    event("AUD-dispatch", "ACTION_EXTERNAL_DISPATCH_STARTED", dispatchAt, "TC-1"),
    event("AUD-claim", "ACTION_EXECUTION_STARTED", claimAt, "TC-1"),
  ];
  return {
    run: { id: "RUN-1", createdAt },
    toolCalls: [{
      id: "TC-1", runId: "RUN-1", name: "create_github_issue", arguments: {},
      canonicalSignature: "create_github_issue:{}", status: "COMPLETED",
      proposedActionId: "PA-1", approvalId: "APR-1", agentIterationId: null,
      triggerMessageId: null, cacheSourceToolCallId: null, iteration: 12, order: 1,
      resultId: "TR-1", requestedAt: createdAt, startedAt: claimAt,
      completedAt: succeededAt, externalDispatchStartedAt: dispatchAt,
      result: {
        id: "TR-1", runId: "RUN-1", toolCallId: "TC-1", status: "SUCCESS",
        output: null, errorMessage: null, retryable: false, createdAt: succeededAt,
      },
    }],
    diagnosis: null,
    proposedAction: {
      id: "PA-1", runId: "RUN-1", diagnosisId: "DX-1", type: "CREATE_GITHUB_ISSUE",
      status: "SUCCEEDED", revision: 1, supersedesProposedActionId: null,
      supersededAt: null, title: "Create issue", arguments: {}, rationale: "Approved",
      createdAt, updatedAt: succeededAt,
    },
    approval: {
      id: "APR-1", runId: "RUN-1", proposedActionId: "PA-1", status: "APPROVED",
      decision: "APPROVE", reason: "Approved", requestedBy: "Agent", decidedBy: "Owner",
      targetOwner: "acme", targetRepo: "repo", revision: 1,
      supersedesApprovalId: null, withdrawnAt: null, createdAt, decidedAt: claimAt,
    },
    auditEvents,
  } as unknown as InvestigationAggregate;
};

test("Audit timeline uses authoritative claim, dispatch and success times", () => {
  const rows = buildRuntimeAuditTimeline(githubTimelineAggregate());
  const actionRows = rows.filter((row) => ["created", "claim", "dispatch", "success"]
    .includes(row.lifecycle) && row.id !== "derived:run-created:RUN-1");
  assert.deepEqual(actionRows.map((row) => [row.lifecycle, row.at]), [
    ["created", "2026-07-29T03:38:18.000Z"],
    ["claim", "2026-07-29T03:50:26.000Z"],
    ["dispatch", "2026-07-29T03:50:27.000Z"],
    ["success", "2026-07-29T03:50:28.000Z"],
  ]);
  assert.equal(rows.some((row) => row.at === "2026-07-29T03:38:18.000Z"
    && /SUCCEEDED|create_github_issue · SUCCESS/.test(row.action)), false);
  assert.equal(rows.filter((row) => row.lifecycle === "success").length, 1);
  assert.equal(rows.find((row) => row.lifecycle === "success")?.source, "audit");
});

test("Audit timeline is deterministic across hydration and equal timestamps", () => {
  const timestamp = "2026-07-29T03:50:26.000Z";
  const aggregate = githubTimelineAggregate({ sharedLifecycleTimestamp: timestamp });
  const beforeRefresh = buildRuntimeAuditTimeline(aggregate);
  const afterHydration = buildRuntimeAuditTimeline(structuredClone(aggregate));
  assert.deepEqual(afterHydration, beforeRefresh);
  assert.deepEqual(beforeRefresh.filter((row) => ["claim", "dispatch", "success"]
    .includes(row.lifecycle)).map((row) => row.lifecycle), ["claim", "dispatch", "success"]);
});

test("Legacy action timeline marks lifecycle fallbacks as derived", () => {
  const rows = buildRuntimeAuditTimeline(githubTimelineAggregate({ auditEvents: [] }));
  const actionCreated = rows.find((row) => row.id === "derived:action-created:PA-1");
  const claim = rows.find((row) => row.lifecycle === "claim");
  const dispatch = rows.find((row) => row.lifecycle === "dispatch");
  const success = rows.find((row) => row.lifecycle === "success");
  assert.equal(actionCreated?.at, "2026-07-29T03:38:18.000Z");
  assert.match(actionCreated?.action ?? "", /PENDING_APPROVAL · derived/);
  assert.deepEqual([claim?.at, dispatch?.at, success?.at], [
    "2026-07-29T03:50:26.000Z",
    "2026-07-29T03:50:27.000Z",
    "2026-07-29T03:50:28.000Z",
  ]);
  assert.ok([actionCreated, claim, dispatch, success].every((row) => row?.source === "derived"));
  assert.equal(rows.some((row) => row.at === "2026-07-29T03:38:18.000Z"
    && row.lifecycle === "success"), false);
});

test("Formal action success suppresses the legacy derived success row", () => {
  const rows = buildRuntimeAuditTimeline(githubTimelineAggregate());
  assert.equal(rows.filter((row) => row.lifecycle === "success").length, 1);
  assert.equal(rows.some((row) => row.id === "derived:action-success:PA-1"), false);
  assert.equal(rows.some((row) => row.id === "audit:AUD-success"), true);
});

test("Audit UI only synthesizes browser workflow success without a runtime aggregate", async () => {
  const source = await pageSource();
  assert.match(source, /!investigation && githubIssue/);
  assert.doesNotMatch(source, /at: call\.requestedAt[\s\S]{0,240}call\.result\?\.status/);
});

const actionAggregate = (input: {
  actionStatus: string;
  callStatus: string;
  approvalStatus?: string;
  resultStatus?: string | null;
  output?: unknown;
}) => ({
  proposedAction: { id: "PA-1", status: input.actionStatus },
  approval: {
    id: "APR-1", status: input.approvalStatus ?? "PENDING",
    targetOwner: "acme", targetRepo: "repo",
  },
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
      repository: { owner: "acme", repo: "repo" },
      createdAt: "2026-07-29T00:00:00.000Z", deduplicated: false },
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
  assert.equal(resolveActionPresentation(actionAggregate({
    actionStatus: "RECONCILIATION_REQUIRED", callStatus: "RECONCILIATION_REQUIRED",
    approvalStatus: "APPROVED",
  })).state, "RECONCILIATION_REQUIRED");
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
  const inconsistent = resolveActionPresentation(actionAggregate({
    actionStatus: "SUCCEEDED", callStatus: "RUNNING", approvalStatus: "APPROVED",
    resultStatus: "SUCCESS",
    output: { number: 42, title: "Release fix", url: "https://github.com/acme/repo/issues/42",
      repository: { owner: "acme", repo: "repo" },
      createdAt: "2026-07-29T00:00:00.000Z", deduplicated: false },
  }));
  assert.notEqual(inconsistent.state, "SUCCEEDED");
  assert.doesNotMatch(inconsistent.title, /已创建/);
});

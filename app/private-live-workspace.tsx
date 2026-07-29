"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type {
  Confidence,
  Evidence as RuntimeEvidence,
  LegacyInvestigationResponse,
} from "@/lib/investigation/types";
import {
  canApplyInvestigationResponse,
  canPresentCurrentInvestigation,
  buildRuntimeAuditTimeline,
  presentationStatusFromRun,
  resolveActionPresentation,
  resolveInvestigationConfidence,
  resolvePlannerUsagePresentation,
  resolveSuccessfulGithubIssue,
  sortAuditTimelineRows,
} from "@/lib/investigation/ui-presentation";

type View = "overview" | "incident" | "approval" | "evidence" | "audit";
type Stage = "pending" | "approved" | "rejected" | "fixed" | "resolved";
type InvestigationStatus = "idle" | "running" | "live" | "error" | "not_configured";
type InvestigationResult = LegacyInvestigationResponse;
type ProviderId = "deepseek" | "kimi" | "openai" | "custom";
type ModelConfig = {
  providerId: ProviderId;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};
type ApprovalSnapshot = {
  id: string;
  submittedAt: string;
  provider: string;
  model: string;
  rootCause: string;
  recommendation: string;
  confidence: Confidence | null;
  evidenceCount: number;
  usage: LegacyInvestigationResponse["usage"];
  parseStatus: "direct" | "repaired" | "raw" | "fixture" | "demo";
};
type ApprovalDecision = {
  id: string;
  decidedAt: string;
  actor: string;
  decision: "approved" | "rejected";
  note: string;
  snapshot: ApprovalSnapshot;
};
type GithubConfig = {
  owner: string;
  repo: string;
  token: string;
};
type GithubIssue = {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  deduplicated: boolean;
};
type GithubActionStatus = "idle" | "running" | "error";
type ApprovalActionStatus = "idle" | "running" | "error";
type WorkflowTimes = {
  startedAt: string;
  fixedAt: string | null;
  resolvedAt: string | null;
};

const SYDNEY_TIME_ZONE = "Australia/Sydney";
const formatSydneyTime = (value: string) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: SYDNEY_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(parsed);
};
const offsetIso = (value: string, seconds: number) => new Date(new Date(value).getTime() + seconds * 1000).toISOString();
const newWorkflowTimes = (): WorkflowTimes => ({
  startedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
  fixedAt: null,
  resolvedAt: null,
});

const providerPresets: Record<ProviderId, Omit<ModelConfig, "apiKey">> = {
  deepseek: { providerId: "deepseek", provider: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" },
  kimi: { providerId: "kimi", provider: "Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "" },
  openai: { providerId: "openai", provider: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "" },
  custom: { providerId: "custom", provider: "", baseUrl: "", model: "" },
};

const navItems: { id: View; label: string; glyph: string }[] = [
  { id: "overview", label: "风险总览", glyph: "▥" },
  { id: "incident", label: "事件调查", glyph: "⌕" },
  { id: "approval", label: "审批中心", glyph: "✓" },
  { id: "evidence", label: "证据库", glyph: "◇" },
  { id: "audit", label: "审计日志", glyph: "≡" },
];

type EvidenceDisplay = {
  id: string;
  label: string;
  source: string;
  color: string;
  detail: string;
  note: string;
  status: string;
};

const evidencePresentation: Record<string, { label: string; color: string }> = {
  PRODUCT_METRIC: { label: "业务指标", color: "blue" },
  RELEASE_CHANGE: { label: "版本改动", color: "violet" },
  SEGMENT_METRIC: { label: "分群指标", color: "cyan" },
  USER_FEEDBACK: { label: "用户反馈", color: "orange" },
  INCIDENT_MEMORY: { label: "历史事故", color: "cyan" },
  SIMILAR_INCIDENT: { label: "历史事故", color: "cyan" },
};

const presentEvidence = (items: RuntimeEvidence[]): EvidenceDisplay[] =>
  items.map((item) => {
    const presentation = evidencePresentation[item.category] ?? { label: item.category, color: "blue" };
    return {
      id: item.id,
      label: presentation.label,
      source: item.source,
      color: presentation.color,
      detail: item.statement,
      note: `${item.strength} 强度 · ${item.provenance}`,
      status: "已持久化",
    };
  });

const confidenceAngle: Record<Confidence, number> = {
  HIGH: 324,
  MEDIUM: 216,
  LOW: 108,
};

const stageFromRuntime = (result: InvestigationResult): Stage => {
  if (["RESOLVED", "PARTIALLY_RESOLVED", "NOT_RECOVERED", "VERIFICATION_INCONCLUSIVE"]
    .includes(result.runStatus)) return "resolved";
  if (result.runStatus === "WAITING_VERIFICATION") return "fixed";
  if (result.runStatus === "CLOSED_NO_ACTION") return "rejected";
  if (result.runStatus === "ACTION_EXECUTING") return "approved";
  if (result.investigation.approval?.status === "REJECTED") return "rejected";
  if (result.investigation.approval?.status === "APPROVED") return "approved";
  return "pending";
};

const snapshotFromRuntime = (result: InvestigationResult): ApprovalSnapshot | null => {
  const approval = result.investigation.approval;
  if (!approval || approval.status === "WITHDRAWN" || !result.investigation.proposedAction) return null;
  return {
    id: approval.id,
    submittedAt: approval.createdAt,
    provider: result.provider,
    model: result.model,
    rootCause: result.conclusion.root_cause,
    recommendation: result.conclusion.recommendation,
    confidence: result.conclusion.confidence,
    evidenceCount: result.investigation.evidence.length,
    usage: result.usage,
    parseStatus: result.conclusion.parse_status,
  };
};

const decisionFromRuntime = (
  result: InvestigationResult,
  snapshot: ApprovalSnapshot | null,
): ApprovalDecision[] => {
  const approval = result.investigation.approval;
  if (!approval?.decision || !approval.decidedAt || !snapshot) return [];
  return [{
    id: approval.id,
    decidedAt: approval.decidedAt,
    actor: approval.decidedBy ?? "产品经理",
    decision: approval.decision === "APPROVE" ? "approved" : "rejected",
    note: approval.reason ?? "",
    snapshot,
  }];
};

const issueFromRuntime = (result: InvestigationResult): GithubIssue | null => {
  return resolveSuccessfulGithubIssue(result.investigation);
};

const ragModeFromRuntime = (result: InvestigationResult | null) => {
  const call = result?.investigation.toolCalls.find((item) =>
    item.name === "search_similar_incidents" && item.result?.status === "SUCCESS");
  const output = call?.result?.output;
  if (!output || typeof output !== "object") return null;
  const matches = (output as { matches?: unknown[] }).matches;
  const first = Array.isArray(matches) ? matches[0] : null;
  if (!first || typeof first !== "object") return null;
  const signals = (first as { retrievalSignals?: Record<string, unknown> }).retrievalSignals;
  const mode = signals?.retrievalMode;
  return typeof mode === "string" ? mode : null;
};

const agentSteps = [
  ["步骤 1", "统计检测", "等待 MetricBucket 满足连续窗口规则", "current"],
  ["步骤 2", "RiskEvent", "统计异常确认后生成服务端风险事件", "pending"],
  ["步骤 3", "Agent 调查", "从 RiskEvent 开始调用正式分析工具", "pending"],
  ["步骤 4", "人工审批", "调查结论进入现有审批与 Action Runtime", "pending"],
];

const toolLabels: Record<string, [string, string]> = {
  get_release: ["版本信息", "读取正式 Release 与变更模块"],
  query_metric: ["业务指标", "查询加权指标 bucket 与动态基线"],
  segment_metric: ["分群分析", "定位异常集中版本与用户分群"],
  search_user_feedback: ["用户反馈", "搜索异常时间附近的关联反馈"],
  search_similar_incidents: ["历史事故", "检索相似事故、根因与处置结果"],
};

function MetricChart({ investigation }: { investigation: InvestigationResult | null }) {
  const riskEvent = investigation?.investigation.riskEvent;
  const release = investigation?.investigation.release;
  if (!riskEvent || !release) {
    return <div className="chart empty-state"><strong>暂无检测结果</strong><span>运行结构化演示后，统计系统会生成并持久化 RiskEvent。</span></div>;
  }
  const baseline = `${(riskEvent.baselineValue * 100).toFixed(1)}%`;
  const current = `${(riskEvent.observedValue * 100).toFixed(1)}%`;
  return (
    <div className="chart" aria-label="优惠券领取成功率趋势图">
      <div className="chart-legend"><span><i className="legend-line baseline" />动态基线 {baseline}</span><span><i className="legend-line current" />当前 {current}</span></div>
      <div className="chart-y"><span>100%</span><span>90%</span><span>80%</span><span>70%</span></div>
      <div className="chart-grid"><div /><div /><div /><div /></div>
      <svg className="chart-svg" viewBox="0 0 700 250" role="img">
        <title>{release.platform} {release.version} 发布后的优惠券领取成功率异常</title>
        <path className="baseline-path" d="M0 48 C80 46 140 51 210 47 S350 50 425 48 S560 49 700 46" />
        <path className="risk-path" d="M360 45 C385 48 390 72 410 78 S438 112 460 122 S485 166 512 178 S544 192 570 197 S620 198 700 202" />
        <line className="release-line" x1="360" x2="360" y1="18" y2="225" />
        <circle className="release-dot" cx="360" cy="45" r="6" /><circle className="risk-dot" cx="676" cy="200" r="7" />
      </svg>
      <span className="release-tag">{release.platform} {release.version} 发布</span><span className="risk-value">{current}<small>{formatSydneyTime(riskEvent.lastBreachedAt).slice(0, 5)}</small></span>
      <div className="chart-x"><span>10:00</span><span>11:00</span><span>12:00</span><span>13:00</span></div>
    </div>
  );
}

function StatusFlow({ stage }: { stage: Stage }) {
  const active = stage === "pending" || stage === "rejected" ? 3 : stage === "approved" ? 4 : stage === "fixed" ? 5 : 6;
  return <div className="status-flow">{["Detect", "Investigate", "Decide", "Approve", "Act", "Verify"].map((item, index) => <div className={index < active ? "flow-step active" : "flow-step"} key={item}><i>{index < active - 1 ? "✓" : index + 1}</i><span>{item}</span></div>)}</div>;
}

function RuntimeTruth({ investigation, ragMode }: {
  investigation: InvestigationResult | null;
  ragMode: string | null;
}) {
  const liveModel = investigation?.investigation.run.plannerType === "LLM";
  const historicalEvidence = investigation?.investigation.evidence.filter((item) =>
    item.source.startsWith("Historical Memory / RAG")) ?? [];
  const hasRealPublicMemory = historicalEvidence.some((item) => item.source.includes("REAL PUBLIC"));
  const hasFixtureMemory = historicalEvidence.some((item) => item.source.includes("FIXTURE"));
  const historicalCorpusLabel = hasRealPublicMemory && hasFixtureMemory
    ? "MIXED" : hasRealPublicMemory ? "REAL PUBLIC" : "FIXTURE";
  const historicalCorpusDescription = historicalCorpusLabel === "MIXED"
    ? "Fixture and public historical evidence, labeled per item"
    : hasRealPublicMemory ? "Public historical incident with source provenance" : "Historical incident corpus";
  return <section className="truth-banner" aria-label="运行数据真实性">
    <div><b>FIXTURE</b><span>Analytics scenario</span></div>
    <div><b>FIXTURE</b><span>Feedback corpus</span></div>
    <div><b>{historicalCorpusLabel}</b><span>{historicalCorpusDescription}</span></div>
    <div><b>FIXTURE</b><span>Deterministic verification data</span></div>
    <div><b className={liveModel ? "truth-live" : "truth-fallback"}>{liveModel ? "LIVE" : "FIXTURE"}</b><span>{liveModel ? "OpenAI-compatible LLM" : "Deterministic Planner"}</span></div>
    <div><b className={ragMode === "HYBRID_VECTORIZE" ? "truth-live" : "truth-fallback"}>{ragMode === "HYBRID_VECTORIZE" ? "LIVE" : "FALLBACK"}</b><span>{ragMode === "HYBRID_VECTORIZE" ? "Workers AI + Vectorize" : "Local retrieval"}</span></div>
    <div><b className="truth-live">REAL WRITE</b><span>GitHub only after Approval</span></div>
  </section>;
}

function GroundedDiagnosisPanel({ investigation }: { investigation: InvestigationResult }) {
  const aggregate = investigation.investigation;
  const diagnosis = aggregate.diagnosis;
  if (!diagnosis) return null;
  const claims = aggregate.diagnosisClaims.filter((item) => item.diagnosisId === diagnosis.id);
  const evidenceById = new Map(aggregate.evidence.map((item) => [item.id, item]));
  return <section className="panel grounded-diagnosis" aria-label="Grounded Diagnosis">
    <div className="panel-heading"><div><span className="section-kicker">GROUNDED DIAGNOSIS · REV {diagnosis.revision}</span><h2>可追溯诊断</h2></div><span className={diagnosis.groundingStatus === "GROUNDED" ? "success-pill" : "pending-pill"}>{diagnosis.groundingStatus}</span></div>
    <div className="diagnosis-meta"><span>Selected Hypothesis Confidence</span><b>{diagnosis.confidence}</b><em>{aggregate.hypotheses.find((item) => item.id === diagnosis.selectedHypothesisId)?.status ?? "LEGACY"}</em></div>
    <p className="diagnosis-summary">{diagnosis.summary}</p>
    <div className="claim-list">{claims.map((claim) => {
      const evidenceIds = aggregate.diagnosisClaimEvidenceLinks.filter((link) => link.claimId === claim.id).map((link) => link.evidenceId);
      return <article key={claim.id}><div><b>{claim.type}</b>{claim.limitationType && <span>{claim.limitationType}</span>}<em>{claim.groundingStatus}</em></div><p>{claim.statement}</p>{evidenceIds.length > 0 && <details><summary>{evidenceIds.length} 条 Evidence 引用</summary>{evidenceIds.map((id) => <small key={id}>{id} · {evidenceById.get(id)?.statement ?? "Evidence unavailable"}</small>)}</details>}</article>;
    })}</div>
  </section>;
}

function RealPublicHistoricalMemory({ investigation }: { investigation: InvestigationResult }) {
  const call = investigation.investigation.toolCalls.find((item) =>
    item.name === "search_similar_incidents" && item.result?.status === "SUCCESS");
  const output = call?.result?.output;
  const matches = output && typeof output === "object" && Array.isArray((output as { matches?: unknown[] }).matches)
    ? (output as { matches: Array<Record<string, unknown>> }).matches : [];
  const publicMatches = matches.filter((item) => {
    const provenance = item.provenance;
    return provenance && typeof provenance === "object"
      && (provenance as Record<string, unknown>).corpusType === "REAL_PUBLIC";
  });
  if (publicMatches.length === 0) return null;
  return <section className="panel grounded-diagnosis" aria-label="Real public historical memory">
    <div className="panel-heading"><div><span className="section-kicker">REAL PUBLIC HISTORICAL MEMORY</span><h2>公开历史事故参考</h2></div><span className="pending-pill">Historical clue only</span></div>
    <div className="claim-list">{publicMatches.map((item) => {
      const provenance = item.provenance as Record<string, unknown>;
      const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : {};
      const categories = Array.isArray(provenance.categories) ? provenance.categories : Array.isArray(metadata.categories) ? metadata.categories : [];
      const mechanisms = Array.isArray(provenance.mechanisms) ? provenance.mechanisms : Array.isArray(metadata.mechanisms) ? metadata.mechanisms : [];
      const source = typeof provenance.originalSourceUrl === "string" ? provenance.originalSourceUrl : null;
      return <article key={String(item.incidentId)}><div><b>{String(provenance.company ?? "Public source")}</b><span>{String(provenance.incidentDateStart ?? "Date unavailable").slice(0, 10)}</span><em>{String(provenance.corpusVersion ?? "Unknown corpus")}</em></div><p>{String(item.title ?? "Historical incident")}</p><small>Mechanism / category: {[...mechanisms, ...categories].join(" · ") || "Source classification unavailable"}</small>{source && <a href={source} target="_blank" rel="noreferrer">Original source</a>}</article>;
    })}</div>
  </section>;
}

function VerificationPanel({ investigation, onAction }: {
  investigation: InvestigationResult;
  onAction: (action: "retry" | "reopen", verificationRunId: string) => Promise<void>;
}) {
  const aggregate = investigation.investigation;
  const latest = [...aggregate.verificationRuns].sort((a, b) => b.attempt - a.attempt)[0];
  if (!latest && investigation.runStatus !== "WAITING_VERIFICATION") return null;
  if (!latest) return <section className="panel verification-panel"><div className="panel-heading"><div><span className="section-kicker">VERIFICATION</span><h2>等待创建验证窗口</h2></div><span className="pending-pill">WAITING_VERIFICATION</span></div><p>Diagnosis 已完成。后续验证将使用 Diagnosis 完成时间或 Action effectiveAt 作为 anchor。</p></section>;
  const policy = aggregate.verificationPolicySnapshots.find((item) => item.verificationRunId === latest.id);
  const evaluation = aggregate.verificationEvaluations.find((item) => item.verificationRunId === latest.id);
  const evidence = aggregate.verificationEvidence.filter((item) => item.verificationRunId === latest.id);
  const stale = latest.attempt !== Math.max(...aggregate.verificationRuns.map((item) => item.attempt));
  const canRetry = !stale && ["PARTIALLY_RESOLVED", "NOT_RECOVERED", "INCONCLUSIVE"].includes(latest.status);
  const canReopen = canRetry && latest.status !== "FAILED" && latest.status !== "RESOLVED";
  return <section className="panel verification-panel" aria-label="Verification outcome">
    <div className="panel-heading"><div><span className="section-kicker">VERIFICATION · ATTEMPT {latest.attempt}</span><h2>恢复验证</h2></div><span className={`verification-outcome outcome-${latest.status.toLowerCase()}`}>{latest.status}</span></div>
    <div className="verification-grid"><div><small>Source</small><b>{latest.anchorType === "ACTION_COMPLETION" ? "ACTION" : "OBSERVE"}</b></div><div><small>Anchor</small><b>{formatSydneyTime(latest.anchorAt)}</b></div><div><small>Window</small><b>{policy ? `${policy.settlingPeriodMinutes}m settle + ${policy.verificationWindowMinutes}m` : "—"}</b></div><div><small>Metric</small><b>{policy?.metricKey ?? "—"}</b></div></div>
    {policy && <p className="verification-policy">Filters {JSON.stringify(policy.affectedFilters)} · min sample {policy.minimumSampleSize} · {policy.requiredConsecutiveBuckets} consecutive buckets · recovery ≥ {policy.metricRecoveryThreshold}</p>}
    <div className="verification-evidence">{evidence.map((item) => <article key={item.id}><b>{item.kind}</b><span>{item.source} · {item.qualityStatus}</span><small>sample {item.sampleSize} · recovery {item.recoveryRatio === null ? "—" : item.recoveryRatio.toFixed(2)}</small></article>)}</div>
    {evaluation && <div className="verification-reason"><b>为什么是 {evaluation.outcome}</b><span>{evaluation.reasonCode}</span></div>}
    {(canRetry || canReopen) && <div className="verification-actions">{canRetry && <button className="secondary-button" onClick={() => void onAction("retry", latest.id)}>Retry Verification</button>}{canReopen && <button className="secondary-button" onClick={() => void onAction("reopen", latest.id)}>Reopen Investigation</button>}</div>}
  </section>;
}

function EvidenceStrip({ onView, items = [] }: { onView: (view: View) => void; items?: EvidenceDisplay[] }) {
  return <section className="panel evidence-panel"><div className="evidence-header"><div><span className="section-kicker">EVIDENCE CHAIN</span><h2>调查证据</h2></div><button className="text-button" onClick={() => onView("evidence")}>查看完整证据链 →</button></div><div className="evidence-grid">{items.map((item) => <button className="evidence-card" key={item.id} onClick={() => onView("evidence")}><span className={`evidence-icon ${item.color}`}>✓</span><div><strong>{item.label}</strong><small>{item.detail}</small></div><b>{item.status}</b></button>)}</div></section>;
}

function Overview({ onView, investigation }: { onView: (view: View) => void; investigation: InvestigationResult | null }) {
  const riskEvent = investigation?.investigation.riskEvent;
  const release = investigation?.investigation.release;
  const diagnosis = investigation?.investigation.diagnosis;
  const kpis = [["blue", "▤", "待处理事件", riskEvent ? "1" : "0", riskEvent ? "统计检测已确认" : "等待检测"], ["red", "!", "高风险", diagnosis?.severity === "HIGH" ? "1" : "0", "需要立即关注"], ["amber", "▣", "待审批", investigation?.runStatus === "WAITING_APPROVAL" ? "1" : "0", "服务端 Runtime"], ["green", "✓", "今日已关闭", "0", "等待验证阶段"]];
  const activeEvidence = investigation ? presentEvidence(investigation.investigation.evidence) : [];
  return <div className="content">
    <RuntimeTruth investigation={investigation} ragMode={ragModeFromRuntime(investigation)} />
    <section className="kpi-grid" aria-label="风险概览指标">{kpis.map(([color, icon, label, value, sub]) => <article className="kpi-card" key={label}><span className={`kpi-icon ${color}`}>{icon}</span><div><small>{label}</small><strong className={`${color}-text`}>{value}</strong><em>{sub}</em></div></article>)}</section>
    <section className="dashboard-grid"><article className="panel metric-panel"><div className="panel-heading"><div><span className="section-kicker">METRIC ANOMALY</span><h2>核心指标异常</h2></div><select aria-label="选择指标"><option>{riskEvent?.metricKey ?? "暂无指标"}</option></select></div><MetricChart investigation={investigation} /></article>
      <article className="panel incident-card">{riskEvent && release ? <><div className="incident-title"><span className="risk-pill">高风险</span><span className="pending-pill">{investigation?.runStatus === "WAITING_APPROVAL" ? "等待审批" : investigation?.runStatus}</span></div><h2>优惠券领取成功率异常</h2><dl className="incident-meta"><div><dt>影响版本</dt><dd>{release.platform} {release.version}</dd></div><div><dt>指标变化</dt><dd><b>{(riskEvent.baselineValue * 100).toFixed(1)}%</b><span>→</span><b className="red-text">{(riskEvent.observedValue * 100).toFixed(1)}%</b></dd></div><div><dt>首次发现</dt><dd>{formatSydneyTime(riskEvent.firstBreachedAt).slice(0, 5)}</dd></div></dl><div className="hypothesis"><span>ROOT CAUSE HYPOTHESIS</span><strong>{diagnosis?.rootCause ?? "等待 Agent 调查"}</strong><p>{diagnosis?.summary ?? "统计系统只负责确认异常，Agent 将从 RiskEvent 开始调查。"}</p></div><div className="confidence-row"><span>根因置信度</span><b>{diagnosis?.confidence ?? "待调查"}</b></div><div className="confidence-track"><i /></div><button className="primary-button" onClick={() => onView("incident")}>查看事件详情 <span>→</span></button></> : <div className="empty-state"><strong>尚未生成 RiskEvent</strong><span>进入事件调查并运行结构化演示。</span><button className="primary-button" onClick={() => onView("incident")}>开始演示 <span>→</span></button></div>}</article>
    </section><EvidenceStrip onView={onView} items={activeEvidence} /></div>;
}

function Incident({ stage, onView, onAdvance, onSubmitApproval, hasApprovalSnapshot, hasGithubIssue, investigationStatus, investigation, currentRunId, investigationError, runInvestigation, runFixtureDemo, activeConfig, onConfigure, onReset, onSendMessage, onVerificationAction, chatBusy }: {
  stage: Stage;
  onView: (view: View) => void;
  onAdvance: () => void;
  onSubmitApproval: () => void;
  hasApprovalSnapshot: boolean;
  hasGithubIssue: boolean;
  investigationStatus: InvestigationStatus;
  investigation: InvestigationResult | null;
  currentRunId: string | null;
  investigationError: string;
  runInvestigation: () => void;
  runFixtureDemo: () => void;
  activeConfig: ModelConfig | null;
  onConfigure: () => void;
  onReset: () => void;
  onSendMessage: (intent: "EXPLAIN" | "INVESTIGATE" | "ADD_HYPOTHESIS", content: string) => Promise<void>;
  onVerificationAction: (action: "retry" | "reopen", verificationRunId: string) => Promise<void>;
  chatBusy: boolean;
}) {
  const [chatIntent, setChatIntent] = useState<"EXPLAIN" | "INVESTIGATE" | "ADD_HYPOTHESIS">("EXPLAIN");
  const [chatDraft, setChatDraft] = useState("");
  const actions: Record<Stage, [string, string]> = {
    pending: [hasApprovalSnapshot ? "查看已送审快照" : "提交人工审批", "approval"],
    approved: hasGithubIssue ? ["生成修复版本 7.3.1", "advance"] : ["创建 GitHub 修复任务", "approval"],
    rejected: ["查看驳回记录", "audit"],
    fixed: ["等待下一阶段恢复验证", "approval"],
    resolved: ["查看审计记录", "audit"],
  };
  const [label, target] = actions[stage];
  const live = canPresentCurrentInvestigation(investigationStatus, investigation, currentRunId)
    ? investigation
    : null;
  const runtimeRelease = live?.investigation.release ?? null;
  const runtimeRisk = live?.investigation.riskEvent ?? null;
  const confidencePresentation = resolveInvestigationConfidence(
    investigationStatus,
    investigation,
    currentRunId,
  );
  const confidence = confidencePresentation.confidence;
  const usagePresentation = resolvePlannerUsagePresentation(live?.usage);
  const runEvidence = live ? presentEvidence(live.investigation.evidence) : [];
  const ragMode = ragModeFromRuntime(live);
  const timeline = live && live.investigation.traceEvents.length > 0
    ? live.investigation.traceEvents.map((item, index) => [
        `#${item.sequence}`,
        item.actor === "HUMAN" ? "产品经理输入" : item.type === "PLANNER_DECISION" ? "Agent 决策" : item.type,
        item.publicSummary,
        index === live.investigation.traceEvents.length - 1 ? "current" : "done",
      ])
    : live
    ? live.trace.map((item, index) => {
        const [title, baseDetail] = toolLabels[item.tool] ?? [item.tool, "完成工具调用"];
        const detail = item.status === "SUCCESS" ? baseDetail : `${baseDetail} · ${item.status}`;
        return [`步骤 ${index + 1}`, title, detail, index === live.trace.length - 1 ? "current" : "done"];
      })
    : agentSteps;
  return <div className="content detail-page">
    <RuntimeTruth investigation={live} ragMode={ragMode} />
    <section className="panel flow-panel"><div className="panel-heading"><div><span className="section-kicker">RISK EVENT {runtimeRisk?.id ?? "等待统计检测"}</span><h2>优惠券领取成功率异常</h2></div><span className={stage === "resolved" ? "success-pill" : "risk-pill"}>{stage === "resolved" ? "验证已完成" : "高风险"}</span></div><StatusFlow stage={stage} /></section>
    <section className="panel demo-launcher" aria-label="Deterministic Demo Scenario"><div><span className="section-kicker">DETERMINISTIC DEMO SCENARIO</span><h2>运行正式 Agent Runtime 演示</h2><p>统计 fixture 先生成 RiskEvent，再由 DeterministicPlanner 驱动共享 AgentLoop。Feedback、历史事故与 Verification 均明确标记为 fixture 数据。</p></div><div className="demo-launcher-actions"><button className="text-button" onClick={onConfigure}>模型配置</button><button className="text-button" onClick={onReset}>重置页面状态</button><button className="primary-button" disabled={investigationStatus === "running"} onClick={runFixtureDemo}>{investigationStatus === "running" ? "演示运行中…" : live ? "重新运行演示" : "运行演示"}</button></div></section>
    <section className="detail-grid"><article className="panel investigation-panel"><div className="panel-heading investigation-heading"><div><span className="section-kicker">AGENT INVESTIGATION</span><h2>调查过程</h2></div><div className="agent-actions">{ragMode && <span className="rag-mode-pill">{ragMode === "HYBRID_VECTORIZE" ? "Hybrid RAG · Vectorize" : ragMode === "HYBRID_LOCAL" ? "Hybrid RAG · Local fallback" : "RAG · Lexical fallback"}</span>}<span className={live ? "live-pill" : "agent-pill"}>{live ? `● ${live.provider} / ${live.model} · 实时` : activeConfig ? `${activeConfig.provider} / ${activeConfig.model}` : "AI Agent · 安全演示"}</span><button className="run-agent-button" disabled={investigationStatus === "running"} onClick={runInvestigation}>{investigationStatus === "running" ? <><i className="spinner" />{activeConfig?.provider || "结构化演示"}调查中</> : live ? "重新调查" : activeConfig ? "运行真实调查" : "运行结构化演示"}</button></div></div>
      <p className="question">“为什么 {runtimeRelease ? `${runtimeRelease.platform} ${runtimeRelease.version}` : "本次发布"} 后，优惠券领取成功率突然下降？”</p>
      {live && <div className="sandbox-note"><b>统计检测 → Agent 调查</b><span>RiskEvent 由确定性规则生成；{live.provider} 只负责从正式分析工具中调查原因。</span></div>}
      {live?.conclusion.parse_status === "repaired" && <div className="result-note"><b>格式已自动整理</b><span>模型原始结论已转换为可审阅的结构化结果，事实内容未改写。</span></div>}
      {live?.conclusion.parse_status === "raw" && <details className="raw-conclusion"><summary>结构化解析未成功 · 查看模型原始结论</summary><p>{live.conclusion.raw_conclusion}</p></details>}
      {investigationStatus === "not_configured" && <div className="agent-alert amber"><b>还差最后一步</b><span>请先选择任意 OpenAI-compatible 模型服务。</span><button onClick={onConfigure}>配置模型 →</button></div>}
      {investigationStatus === "error" && <div className="agent-alert red"><b>调查失败</b><span>{investigationError}</span></div>}
      <div className="agent-timeline">{timeline.map(([time, title, detail, status], index) => <div className={`timeline-item ${status}`} key={`${title}-${index}`}><time>{time}</time><i /><div><strong>{title}</strong><p>{detail}</p></div></div>)}</div>
      {live && <div className="token-note">Run {live.runId.slice(0, 18)}… · {live.runStatus} · {live.trace.length} 个工具 · 输入 {usagePresentation.input} · 输出 {usagePresentation.output} · 总计 {usagePresentation.total} · usage {usagePresentation.completenessLabel}</div>}</article>
      <aside className="panel decision-panel"><span className="section-kicker">DECISION BRIEF</span><h2>处置建议</h2><div className="score-ring" style={{ "--score": `${confidence ? confidenceAngle[confidence] : 0}deg` } as CSSProperties}><strong className={confidence === null ? "score-pending" : ""}>{confidencePresentation.label}</strong><small>根因置信度</small></div><h3>{live ? live.conclusion.recommendation : "等待结构化调查"}</h3><div className="root-cause"><small>根因判断</small><p>{live ? live.conclusion.root_cause : "RiskEvent 只确认异常，不预设根因"}</p></div><ul><li>预计恢复时间：15 分钟</li><li>影响范围：{runtimeRelease ? `${runtimeRelease.platform} ${runtimeRelease.version}` : "等待检测"}</li><li>{live?.conclusion.requires_human_approval ? "模型要求：必须人工审批" : "变更风险：等待调查"}</li></ul><button className="primary-button" onClick={() => target === "advance" ? onAdvance() : target === "approval" ? (hasApprovalSnapshot ? onView("approval") : onSubmitApproval()) : onView(target as View)}>{label} <span>→</span></button></aside></section>
    {live && <section className="phase3-collaboration">
      <article className="panel hypothesis-board">
        <div className="panel-heading"><div><span className="section-kicker">HYPOTHESIS BOARD</span><h2>根因假设与证据</h2></div><span className="pending-pill">Diagnosis rev {live.investigation.diagnosis?.revision ?? 0}</span></div>
        <div className="hypothesis-list">{live.investigation.hypotheses.map((item) => {
          const links = live.investigation.hypothesisEvidenceLinks.filter((link) => link.hypothesisId === item.id);
          const selected = live.investigation.diagnosis?.selectedHypothesisId === item.id;
          const role = item.status === "REJECTED" ? "Rejected Alternative" : selected ? "Leading Hypothesis" : "Still Unresolved";
          const linkedEvidence = (relation: "SUPPORTS" | "CONTRADICTS" | "NEUTRAL") => links
            .filter((link) => link.relation === relation)
            .map((link) => ({ link, evidence: live.investigation.evidence.find((evidence) => evidence.id === link.evidenceId) }));
          return <article className={`hypothesis-card ${selected ? "leading" : item.status.toLowerCase()}`} key={item.id}><div><span>{role} · {item.createdBy === "HUMAN" ? "PM" : "Agent"}</span><b>{item.status} · {item.confidence}</b></div><h3>{item.statement}</h3><dl><div><dt>Support if</dt><dd>{item.supportIf}</dd></div><div><dt>Refute if</dt><dd>{item.refuteIf}</dd></div></dl><p>{item.confidenceReason}</p><section className="relation-group supports"><b>Supporting Evidence</b>{linkedEvidence("SUPPORTS").map(({ link, evidence }) => <small key={link.id}>{evidence?.category === "SIMILAR_INCIDENT" ? "Historical Memory / RAG · " : ""}{evidence?.statement ?? link.evidenceId}<em>{evidence?.source} · {evidence?.category}</em></small>)}</section><section className="relation-group contradicts"><b>Contradicting Evidence</b>{linkedEvidence("CONTRADICTS").map(({ link, evidence }) => <small key={link.id}>{evidence?.statement ?? link.evidenceId}<em>{evidence?.source} · {evidence?.category}</em></small>)}</section>{linkedEvidence("NEUTRAL").length > 0 && <details className="neutral-evidence"><summary>Neutral Evidence ({linkedEvidence("NEUTRAL").length})</summary>{linkedEvidence("NEUTRAL").map(({ link, evidence }) => <small key={link.id}>{evidence?.statement ?? link.evidenceId}</small>)}</details>}</article>;
        })}</div>
      </article>
      <article className="panel agent-chat">
        <div className="panel-heading"><div><span className="section-kicker">HUMAN × AGENT</span><h2>与调查 Agent 讨论</h2></div><span className="live-pill">{live.investigation.run.plannerType} Planner</span></div>
        <div className="chat-history">{live.investigation.messages.length === 0 ? <p className="chat-empty">可以要求解释现有证据、继续调用工具，或提出一个产品经理假设。</p> : live.investigation.messages.map((message) => <div className={`chat-message ${message.role.toLowerCase()}`} key={message.id}><b>{message.role === "USER" ? "产品经理" : "Agent"}</b><p>{message.content}</p>{message.citedEvidenceIds.length > 0 && <small>引用 {message.citedEvidenceIds.length} 条证据</small>}</div>)}</div>
        <div className="chat-intents"><button className={chatIntent === "EXPLAIN" ? "active" : ""} onClick={() => setChatIntent("EXPLAIN")}>解释证据</button><button className={chatIntent === "INVESTIGATE" ? "active" : ""} onClick={() => setChatIntent("INVESTIGATE")}>继续调查</button><button className={chatIntent === "ADD_HYPOTHESIS" ? "active" : ""} onClick={() => setChatIntent("ADD_HYPOTHESIS")}>添加假设</button></div>
        <form className="chat-compose" onSubmit={(event) => { event.preventDefault(); if (!chatDraft.trim()) return; void onSendMessage(chatIntent, chatDraft).then(() => setChatDraft("")); }}><textarea value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} placeholder={chatIntent === "ADD_HYPOTHESIS" ? "例如：异常可能主要集中在新用户。" : "输入你想让 Agent 解释或调查的方向…"} disabled={chatBusy} /><button className="primary-button" disabled={chatBusy || !chatDraft.trim()}>{chatBusy ? "Agent 调查中…" : "发送"}</button></form>
      </article>
    </section>}
    {live && <GroundedDiagnosisPanel investigation={live} />}
    {live && <RealPublicHistoricalMemory investigation={live} />}
    {live && <VerificationPanel investigation={live} onAction={onVerificationAction} />}
    <EvidenceStrip onView={onView} items={runEvidence} /></div>;
}

function ModelConfigModal({ initial, onClose, onSave, onClear }: {
  initial: ModelConfig | null;
  onClose: () => void;
  onSave: (config: ModelConfig) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<ModelConfig>(initial ?? { ...providerPresets.deepseek, apiKey: "" });
  const [error, setError] = useState("");
  const selectProvider = (providerId: ProviderId) => {
    const preset = providerPresets[providerId];
    setDraft({ ...preset, apiKey: draft.apiKey });
    setError("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.provider.trim() || !draft.baseUrl.trim() || !draft.model.trim() || !draft.apiKey.trim()) {
      setError("请完整填写服务商、Base URL、Model ID 和 API Key。");
      return;
    }
    try {
      if (new URL(draft.baseUrl).protocol !== "https:") throw new Error();
    } catch {
      setError("Base URL 必须是完整的 HTTPS 地址。");
      return;
    }
    onSave({ ...draft, provider: draft.provider.trim(), baseUrl: draft.baseUrl.trim(), model: draft.model.trim(), apiKey: draft.apiKey.trim() });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="model-modal" role="dialog" aria-modal="true" aria-labelledby="model-config-title">
      <div className="modal-heading"><div><span className="section-kicker">MODEL CONNECTION</span><h2 id="model-config-title">模型服务配置</h2></div><button className="modal-close" aria-label="关闭模型配置" onClick={onClose}>×</button></div>
      <p className="modal-intro">支持 OpenAI-compatible Chat Completions 接口。预设只是快捷填写，所有字段都可以修改。</p>
      <form onSubmit={submit}>
        <label>服务商预设<select value={draft.providerId} onChange={(event) => selectProvider(event.target.value as ProviderId)}><option value="deepseek">DeepSeek</option><option value="kimi">Kimi</option><option value="openai">OpenAI</option><option value="custom">自定义服务</option></select></label>
        <label>服务商显示名称<input value={draft.provider} onChange={(event) => setDraft({ ...draft, provider: event.target.value })} placeholder="例如：公司内部模型网关" autoComplete="off" /></label>
        <label>API Base URL<input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" inputMode="url" autoComplete="off" /><small>系统会自动补充 /chat/completions</small></label>
        <label>Model ID<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="填写控制台提供的准确模型 ID" autoComplete="off" /></label>
        <label>API Key<input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder="只在这里输入，不要发到聊天中" autoComplete="off" /></label>
        <div className="security-note"><i>✓</i><span>Key 仅保存在当前浏览器会话；调用时经本站服务端转发到所填 API 地址，不写入源码或数据库。</span></div>
        {error && <p className="config-error">{error}</p>}
        <div className="modal-actions">{initial && <button type="button" className="clear-config" onClick={onClear}>清除配置</button>}<button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存本次会话</button></div>
      </form>
    </section>
  </div>;
}

function GithubConfigModal({ initial, onClose, onSave, onClear }: {
  initial: GithubConfig | null;
  onClose: () => void;
  onSave: (config: GithubConfig) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState<GithubConfig>(initial ?? { owner: "", repo: "", token: "" });
  const [error, setError] = useState("");
  const [testStatus, setTestStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [testMessage, setTestMessage] = useState("");
  const validate = () => {
    if (!draft.owner.trim() || !draft.repo.trim() || !draft.token.trim()) {
      setError("请完整填写 GitHub 用户或组织、仓库名和访问令牌。");
      return false;
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(draft.owner.trim()) || !/^[A-Za-z0-9_.-]+$/.test(draft.repo.trim())) {
      setError("GitHub 用户或组织、仓库名格式不正确。");
      return false;
    }
    setError("");
    return true;
  };
  const updateDraft = (next: GithubConfig) => {
    setDraft(next);
    setError("");
    setTestStatus("idle");
    setTestMessage("");
  };
  const testConnection = async () => {
    if (!validate()) return;
    setTestStatus("running");
    setTestMessage("");
    try {
      const response = await fetch("/api/github-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: draft }),
      });
      const payload = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(payload.error || "GitHub 连接测试失败");
      setTestStatus("success");
      setTestMessage(payload.message || `已连接 ${draft.owner}/${draft.repo}`);
    } catch (connectionError) {
      setTestStatus("error");
      setTestMessage(connectionError instanceof Error ? connectionError.message : "GitHub 连接测试失败");
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validate()) return;
    onSave({ owner: draft.owner.trim(), repo: draft.repo.trim(), token: draft.token.trim() });
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="model-modal" role="dialog" aria-modal="true" aria-labelledby="github-config-title">
      <div className="modal-heading"><div><span className="section-kicker">ACTION CONNECTOR</span><h2 id="github-config-title">连接 GitHub Issue</h2></div><button className="modal-close" aria-label="关闭 GitHub 配置" onClick={onClose}>×</button></div>
      <p className="modal-intro">当前先接 GitHub；以后可把 Jira 作为并列任务连接器，不会影响调查模型配置。</p>
      <form onSubmit={submit}>
        <label>GitHub 用户或组织<input value={draft.owner} onChange={(event) => updateDraft({ ...draft, owner: event.target.value })} placeholder="例如：your-company" autoComplete="off" /></label>
        <label>仓库名<input value={draft.repo} onChange={(event) => updateDraft({ ...draft, repo: event.target.value })} placeholder="例如：coupon-service" autoComplete="off" /></label>
        <label>Fine-grained access token<input type="password" value={draft.token} onChange={(event) => updateDraft({ ...draft, token: event.target.value })} placeholder="只在这里输入，不要发到聊天中" autoComplete="off" /></label>
        <div className="security-note"><i>✓</i><span>Token 仅保存在当前浏览器会话；只有你点击“创建 GitHub Issue”后才会调用 GitHub。</span></div>
        {error && <p className="config-error">{error}</p>}
        {testMessage && <p className={testStatus === "success" ? "connection-result success" : "connection-result error"}>{testStatus === "success" ? "✓ " : "× "}{testMessage}</p>}
        <div className="modal-actions">{initial && <button type="button" className="clear-config" onClick={onClear}>清除配置</button>}<button type="button" className="secondary-button" onClick={testConnection} disabled={testStatus === "running"}>{testStatus === "running" ? "测试中…" : "测试连接"}</button><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="submit" className="primary-button">保存本次会话</button></div>
      </form>
    </section>
  </div>;
}

function Approval({ stage, snapshot, investigation, latestDecision, githubConfig, githubIssue, approvalStatus, approvalError, githubStatus, githubError, approve, reject, onInvestigate, onConfigureGithub, onCreateGithubIssue, onContinueInvestigation }: {
  stage: Stage;
  snapshot: ApprovalSnapshot | null;
  investigation: InvestigationResult | null;
  latestDecision: ApprovalDecision | null;
  githubConfig: GithubConfig | null;
  githubIssue: GithubIssue | null;
  approvalStatus: ApprovalActionStatus;
  approvalError: string;
  githubStatus: GithubActionStatus;
  githubError: string;
  approve: (note: string) => Promise<void>;
  reject: (note: string) => Promise<void>;
  onInvestigate: () => void;
  onConfigureGithub: () => void;
  onCreateGithubIssue: () => void;
  onContinueInvestigation: () => Promise<void>;
}) {
  const defaultNote = "证据充分，同意按建议方案生成修复版本；发布后继续观察 15 分钟。";
  const [reviewNote, setReviewNote] = useState(
    latestDecision && latestDecision.id === snapshot?.id ? latestDecision.note : defaultNote,
  );
  if (!snapshot) return <div className="content detail-page"><section className="panel empty-approval"><span className="empty-icon">◇</span><h2>还没有待审批方案</h2><p>先完成一次调查，再从处置建议中提交人工审批。</p><button className="primary-button" onClick={onInvestigate}>前往事件调查 <span>→</span></button></section></div>;
  const confidenceLabel = snapshot.confidence ?? "待复核";
  const usagePresentation = resolvePlannerUsagePresentation(snapshot.usage);
  const actionPresentation = resolveActionPresentation(investigation?.investigation ?? null);
  const approvedDecision = latestDecision && latestDecision.id === snapshot.id && latestDecision.decision === "approved" ? latestDecision : null;
  const decisionLabel = stage === "pending" ? "等待你的决策" : stage === "rejected" ? "已驳回并留痕" : "已批准并留痕";
  return <div className="content detail-page"><section className="approval-layout"><article className="panel approval-main"><div className="panel-heading"><div><span className="section-kicker">CHANGE APPROVAL · {snapshot.id}</span><h2>修复方案审批</h2></div><span className={stage === "pending" ? "pending-pill" : stage === "rejected" ? "risk-pill" : "success-pill"}>{decisionLabel}</span></div><div className="snapshot-banner"><i>✓</i><div><b>审批快照已冻结</b><span>{snapshot.provider} / {snapshot.model} · {formatSydneyTime(snapshot.submittedAt)} 提交</span></div></div>{approvedDecision && <div className="decision-result"><i>✓</i><div><b>产品经理已批准</b><span>{formatSydneyTime(approvedDecision.decidedAt)} · 审批意见已写入服务端审计日志</span></div></div>}<div className="approval-summary"><span className="risk-pill">P1 高风险</span><h3>{snapshot.recommendation}</h3><p><strong>根因判断：</strong>{snapshot.rootCause}</p></div><div className="check-grid"><div><b>{snapshot.evidenceCount} / 4</b><span>调查工具完成</span></div><div><b>{confidenceLabel}</b><span>根因置信度</span></div><div><b>{usagePresentation.total}</b><span>输入 {usagePresentation.input} · 输出 {usagePresentation.output} · {usagePresentation.completenessLabel}</span></div><div><b>Rev {snapshot.id.slice(-4)}</b><span>冻结快照</span></div></div><label className="review-note">审批备注<textarea value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} disabled={stage !== "pending" || approvalStatus === "running"} /></label>{stage === "pending" && <div className="continue-investigation"><div><b>认为调查还不充分？</b><span>撤回当前待审批快照，保留 Revision 历史并回到 Agent 调查。</span></div><button className="secondary-button" disabled={approvalStatus === "running"} onClick={() => void onContinueInvestigation()}>继续调查</button></div>}<div className="approval-actions"><button className="danger-button" onClick={() => void reject(reviewNote)} disabled={stage !== "pending" || approvalStatus === "running"}>驳回并关闭（不执行）</button><button className="primary-button" onClick={() => void approve(reviewNote)} disabled={stage !== "pending" || approvalStatus === "running"}>{approvalStatus === "running" ? "正在提交…" : stage === "pending" ? "批准修复方案" : "✓ 已处理"}</button></div>{approvalError && <p className="action-error">{approvalError}</p>}{stage !== "pending" && stage !== "rejected" && <section className="execution-card"><div><span className="section-kicker">EXTERNAL ACTION</span><h3>GitHub 修复任务</h3><p>服务端只执行本次 Approval 已批准并冻结的 ProposedAction；重复点击不会重复建单。</p></div>{githubIssue ? <div className="issue-created"><i>✓</i><div><b>Issue #{githubIssue.number} 已就绪</b><span>{githubIssue.title}</span></div><a href={githubIssue.url} target="_blank" rel="noreferrer">打开 GitHub ↗</a></div> : <div className="execution-actions"><span className={githubConfig ? "connector-ready" : "connector-missing"}>{githubConfig ? `已批准目标 ${githubConfig.owner}/${githubConfig.repo}` : "当前会话缺少访问令牌"}</span><button className="secondary-button" onClick={onConfigureGithub}>{githubConfig ? "更新令牌" : "配置 GitHub"}</button><button className="primary-button" disabled={!githubConfig || githubStatus === "running"} onClick={onCreateGithubIssue}>{githubStatus === "running" ? "正在执行…" : "执行已批准 Action"}</button></div>}{githubError && <p className="action-error">{githubError}</p>}</section>}</article>
      <aside className="panel audit-preview"><span className="section-kicker">ACTION STATUS · {actionPresentation.state}</span><div className="action-truth"><b>{actionPresentation.title}</b><span>{actionPresentation.detail}</span></div><span className="section-kicker">SAFETY CONTROLS</span><h2>安全控制</h2>{["外部写操作必须绑定人工 Approval", "GitHub Issue 只是工作项，不代表修复已上线", "每一步输入、工具与决策均留痕", "Verification 由确定性 Policy 计算，不自动回滚"].map((item) => <p key={item}><i>✓</i>{item}</p>)}</aside></section></div>;
}

function EvidenceView({ items }: { items: EvidenceDisplay[] }) {
  return <div className="content detail-page"><section className="panel evidence-library"><div className="panel-heading"><div><span className="section-kicker">TRACEABLE EVIDENCE</span><h2>事件证据链</h2></div><span className="success-pill">{items.length} 条已持久化</span></div><div className="evidence-list">{items.map((item, index) => <article key={item.id}><span className={`evidence-icon ${item.color}`}>{index + 1}</span><div><small>{item.source}</small><h3>{item.label} · {item.detail}</h3><p>{item.note}</p><code>evidence_id: {item.id}</code></div><b>{item.status}</b></article>)}</div></section></div>;
}

function Audit({ stage, snapshot, decisions, githubIssue, workflowTimes, investigation }: { stage: Stage; snapshot: ApprovalSnapshot | null; decisions: ApprovalDecision[]; githubIssue: GithubIssue | null; workflowTimes: WorkflowTimes; investigation: InvestigationResult | null }) {
  const confidence = snapshot?.confidence ?? "";
  const formalDecisionTypes = new Set(investigation?.investigation.auditEvents.map((event) => event.type) ?? []);
  const runtimeRows = investigation ? buildRuntimeAuditTimeline(investigation.investigation) : [
    { id: "demo:event-created", at: workflowTimes.startedAt, actor: "System", action: "创建事件 RG-2026-0726-01 · derived", permission: "只读", source: "derived" as const, lifecycle: "created" as const, sortOrder: 0 },
    { id: "demo:tools-selected", at: offsetIso(workflowTimes.startedAt, 66), actor: "Agent", action: "选择 4 个调查工具 · derived", permission: "只读", source: "derived" as const, lifecycle: "observation" as const, sortOrder: 20 },
    { id: "demo:recommendation-created", at: offsetIso(workflowTimes.startedAt, 324), actor: "Agent", action: "输出根因假设与修复建议 · derived", permission: "只读", source: "derived" as const, lifecycle: "observation" as const, sortOrder: 25 },
  ];
  const rows = sortAuditTimelineRows([
    ...runtimeRows,
    ...(snapshot ? [{ id: `snapshot:${snapshot.id}`, at: snapshot.submittedAt, actor: "Agent", action: `冻结审批快照 · ${snapshot.provider}/${snapshot.model} · ${confidence} · derived`, permission: "只读", source: "derived" as const, lifecycle: "created" as const, sortOrder: 35 }] : []),
    ...decisions.filter((item) => !formalDecisionTypes.has(item.decision === "approved" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED")).map((item) => ({ id: `decision:${item.id}:${item.decision}`, at: item.decidedAt, actor: item.actor, action: `${item.decision === "approved" ? "批准" : "驳回"}修复方案 ${item.id} · ${item.note} · derived`, permission: item.decision === "approved" ? "已授权" : "已归档", source: "derived" as const, lifecycle: "status" as const, sortOrder: 50 })),
    ...(snapshot && stage === "pending" ? [{ id: `approval-pending:${snapshot.id}`, at: offsetIso(snapshot.submittedAt, 1), actor: "产品经理", action: `等待审批方案 ${snapshot.id} · derived`, permission: "待操作", source: "derived" as const, lifecycle: "status" as const, sortOrder: 40 }] : []),
    ...(!investigation && githubIssue ? [{ id: `demo:github-issue:${githubIssue.number}`, at: githubIssue.createdAt, actor: "Action Agent", action: `创建 GitHub Issue #${githubIssue.number}${githubIssue.deduplicated ? " · 命中防重复记录" : ""} · derived`, permission: "已授权", source: "derived" as const, lifecycle: "success" as const, sortOrder: 90 }] : []),
    ...(workflowTimes.fixedAt ? [{ id: "workflow:fixed", at: workflowTimes.fixedAt, actor: "Repair Agent", action: "生成修复版本 Android 7.3.1 · derived", permission: "已授权", source: "derived" as const, lifecycle: "status" as const, sortOrder: 100 }] : []),
    ...(workflowTimes.resolvedAt ? [{ id: "workflow:resolved", at: workflowTimes.resolvedAt, actor: "Verifier", action: "成功率恢复至 95%，事件关闭 · derived", permission: "自动验证", source: "derived" as const, lifecycle: "status" as const, sortOrder: 110 }] : []),
  ]);
  return <div className="content detail-page"><section className="panel audit-table"><div className="panel-heading"><div><span className="section-kicker">IMMUTABLE AUDIT TRAIL</span><h2>事件操作记录</h2></div><span className="timezone-label">Australia/Sydney</span><button className="secondary-button">导出 JSON</button></div><div className="table-head"><span>时间</span><span>执行者</span><span>动作</span><span>权限</span></div>{rows.map((row) => <div className="table-row" key={row.id}><time>{formatSydneyTime(row.at)}</time><strong>{row.actor}</strong><span>{row.action}</span><b>{row.permission}</b></div>)}</section></div>;
}

export default function PrivateLiveWorkspace() {
  const [view, setView] = useState<View>("overview");
  const [stage, setStage] = useState<Stage>("pending");
  const [, setLastUpdated] = useState("2 分钟前");
  const [toast, setToast] = useState("");
  const [investigationStatus, setInvestigationStatus] = useState<InvestigationStatus>("idle");
  const [investigation, setInvestigation] = useState<InvestigationResult | null>(null);
  const [investigationError, setInvestigationError] = useState("");
  const [approvalSnapshot, setApprovalSnapshot] = useState<ApprovalSnapshot | null>(null);
  const [approvalDecisions, setApprovalDecisions] = useState<ApprovalDecision[]>([]);
  const [workflowHydrated, setWorkflowHydrated] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig | null>(null);
  const [githubConfig, setGithubConfig] = useState<GithubConfig | null>(null);
  const [githubIssue, setGithubIssue] = useState<GithubIssue | null>(null);
  const [approvalStatus, setApprovalStatus] = useState<ApprovalActionStatus>("idle");
  const [approvalError, setApprovalError] = useState("");
  const [githubStatus, setGithubStatus] = useState<GithubActionStatus>("idle");
  const [githubError, setGithubError] = useState("");
  const [workflowTimes, setWorkflowTimes] = useState<WorkflowTimes>(newWorkflowTimes);
  const [showModelConfig, setShowModelConfig] = useState(false);
  const [showGithubConfig, setShowGithubConfig] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const investigationRequest = useRef(0);
  const currentRunIdRef = useRef<string | null>(null);
  const clearCurrentInvestigation = () => {
    investigationRequest.current += 1;
    currentRunIdRef.current = null;
    setCurrentRunId(null);
    setInvestigation(null);
  };
  const acceptInvestigationResponse = (
    payload: InvestigationResult,
    requestGeneration: number,
    expectedRunId: string | null,
  ) => {
    if (!canApplyInvestigationResponse(
      requestGeneration,
      investigationRequest.current,
      expectedRunId,
      payload.runId,
    )) return false;
    currentRunIdRef.current = payload.runId;
    setCurrentRunId(payload.runId);
    setInvestigation(payload);
    const presentationStatus = presentationStatusFromRun(payload);
    setInvestigationStatus(presentationStatus);
    setInvestigationError(presentationStatus === "error"
      ? payload.investigation.run.errorMessage ?? "服务端调查运行失败"
      : "");
    const snapshot = snapshotFromRuntime(payload);
    setStage(stageFromRuntime(payload));
    setApprovalSnapshot(snapshot);
    setApprovalDecisions(decisionFromRuntime(payload, snapshot));
    setGithubIssue(issueFromRuntime(payload));
    window.sessionStorage.setItem("releaseguard:run-id", payload.runId);
    return true;
  };
  useEffect(() => {
    const requestGeneration = ++investigationRequest.current;
    let active = true;
    const hydrate = async () => {
      await Promise.resolve();
      try {
        const saved = window.sessionStorage.getItem("releaseguard:model-config");
        if (saved && active) setModelConfig(JSON.parse(saved) as ModelConfig);
        const savedGithub = window.sessionStorage.getItem("releaseguard:github-config");
        if (savedGithub && active) setGithubConfig(JSON.parse(savedGithub) as GithubConfig);
        const savedWorkflow = window.sessionStorage.getItem("releaseguard:workflow");
        if (savedWorkflow && active && requestGeneration === investigationRequest.current) {
          const workflow = JSON.parse(savedWorkflow) as { stage?: Stage; snapshot?: ApprovalSnapshot | null; decisions?: ApprovalDecision[]; githubIssue?: GithubIssue | null; workflowTimes?: WorkflowTimes };
          if (workflow.stage) setStage(workflow.stage);
          setApprovalSnapshot(workflow.snapshot ?? null);
          setApprovalDecisions(workflow.decisions ?? []);
          setGithubIssue(workflow.githubIssue ?? null);
          if (workflow.workflowTimes?.startedAt) setWorkflowTimes(workflow.workflowTimes);
        }
      } catch {
        window.sessionStorage.removeItem("releaseguard:model-config");
        window.sessionStorage.removeItem("releaseguard:github-config");
        window.sessionStorage.removeItem("releaseguard:workflow");
      }
      try {
        const savedRunId = window.sessionStorage.getItem("releaseguard:run-id");
        const response = await fetch(savedRunId
          ? `/api/investigate?runId=${encodeURIComponent(savedRunId)}`
          : "/api/investigate");
        if (response.ok && active) {
          const persisted = await response.json() as InvestigationResult;
          acceptInvestigationResponse(persisted, requestGeneration, savedRunId);
        }
      } catch {
        // The static demo remains available when no persisted run exists yet.
      } finally {
        if (active) setWorkflowHydrated(true);
      }
    };
    void hydrate();
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!workflowHydrated) return;
    window.sessionStorage.setItem("releaseguard:workflow", JSON.stringify({ stage, snapshot: approvalSnapshot, decisions: approvalDecisions, githubIssue, workflowTimes }));
  }, [workflowHydrated, stage, approvalSnapshot, approvalDecisions, githubIssue, workflowTimes]);
  const activeLabel = useMemo(() => navItems.find((item) => item.id === view)?.label ?? "风险总览", [view]);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };
  const decide = async (decision: ApprovalDecision["decision"], note: string) => {
    const action = investigation?.investigation.proposedAction;
    if (!investigation || !approvalSnapshot || !action) {
      setApprovalError("当前没有可审批的服务端 ProposedAction。");
      return;
    }
    const expectedRunId = investigation.runId;
    const requestGeneration = investigationRequest.current;
    if (decision === "approved" && !githubConfig) {
      setApprovalError("批准前请先配置 GitHub 目标；仓库会随 Approval 一起冻结。");
      setShowGithubConfig(true);
      return;
    }
    setApprovalStatus("running");
    setApprovalError("");
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: investigation.runId,
          proposedActionId: action.id,
          decision: decision === "approved" ? "APPROVE" : "REJECT",
          reason: note,
          target: decision === "approved" && githubConfig
            ? { owner: githubConfig.owner, repo: githubConfig.repo }
            : undefined,
        }),
      });
      const payload = await response.json() as InvestigationResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "审批请求失败");
      if (!acceptInvestigationResponse(payload, requestGeneration, expectedRunId)) return;
      notify(decision === "approved"
        ? "Approval 已由服务端批准，GitHub 目标已冻结"
        : "Approval 已驳回，Action 已取消并写入审计记录");
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "审批请求失败");
      setApprovalStatus("error");
      return;
    }
    setApprovalStatus("idle");
  };
  const approve = (note: string) => decide("approved", note);
  const reject = (note: string) => decide("rejected", note);
  const advance = () => notify("Action 完成后需人工确认 effectiveAt，随后由 Verification Runtime 判断恢复结果");
  const reset = () => { clearCurrentInvestigation(); window.sessionStorage.removeItem("releaseguard:run-id"); setStage("pending"); setView("overview"); setInvestigationStatus("idle"); setApprovalSnapshot(null); setApprovalDecisions([]); setGithubIssue(null); setApprovalStatus("idle"); setApprovalError(""); setGithubStatus("idle"); setGithubError(""); setInvestigationError(""); setWorkflowTimes(newWorkflowTimes()); notify("演示状态已重置"); };
  const submitForApproval = () => {
    if (!investigation?.investigation.approval) {
      notify("请先运行结构化调查，服务端会自动创建 Approval");
      return;
    }
    const snapshot = snapshotFromRuntime(investigation);
    setApprovalSnapshot(snapshot);
    setView("approval");
    notify(`服务端 Approval ${investigation.investigation.approval.id} 已载入`);
  };
  const saveModelConfig = (config: ModelConfig) => {
    window.sessionStorage.setItem("releaseguard:model-config", JSON.stringify(config));
    setModelConfig(config);
    clearCurrentInvestigation();
    window.sessionStorage.removeItem("releaseguard:run-id");
    setInvestigationStatus("idle");
    setShowModelConfig(false);
    notify(`${config.provider} / ${config.model} 已连接到本次会话`);
  };
  const clearModelConfig = () => {
    window.sessionStorage.removeItem("releaseguard:model-config");
    setModelConfig(null);
    clearCurrentInvestigation();
    window.sessionStorage.removeItem("releaseguard:run-id");
    setInvestigationStatus("idle");
    setShowModelConfig(false);
    notify("模型配置已从本次会话清除");
  };
  const saveGithubConfig = (config: GithubConfig) => {
    window.sessionStorage.setItem("releaseguard:github-config", JSON.stringify(config));
    setGithubConfig(config);
    setGithubError("");
    setShowGithubConfig(false);
    notify(`GitHub ${config.owner}/${config.repo} 已连接到本次会话`);
  };
  const clearGithubConfig = () => {
    window.sessionStorage.removeItem("releaseguard:github-config");
    setGithubConfig(null);
    setGithubError("");
    setShowGithubConfig(false);
    notify("GitHub 连接已从本次会话清除");
  };
  const createGithubIssue = async () => {
    const action = investigation?.investigation.proposedAction;
    if (stage !== "approved" || !investigation || !action || !githubConfig || githubIssue || githubStatus === "running") return;
    const expectedRunId = investigation.runId;
    const requestGeneration = investigationRequest.current;
    setGithubStatus("running");
    setGithubError("");
    try {
      const response = await fetch("/api/github-issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: investigation.runId,
          proposedActionId: action.id,
          config: { token: githubConfig.token },
        }),
      });
      const payload = await response.json() as GithubIssue & { error?: string };
      if (!response.ok) throw new Error(payload.error || "GitHub Issue 创建失败");
      setGithubIssue(payload);
      const refreshed = await fetch(`/api/investigate?runId=${encodeURIComponent(investigation.runId)}`);
      if (refreshed.ok) {
        const persisted = await refreshed.json() as InvestigationResult;
        if (!acceptInvestigationResponse(persisted, requestGeneration, expectedRunId)) return;
        setGithubIssue(issueFromRuntime(persisted) ?? payload);
      }
      notify(payload.deduplicated ? `已找到现有 GitHub Issue #${payload.number}，未重复创建` : `工作项 #${payload.number} 已创建，尚未确认修复上线`);
    } catch (error) {
      setGithubStatus("error");
      setGithubError(error instanceof Error ? error.message : "GitHub Issue 创建失败");
      return;
    }
    setGithubStatus("idle");
  };
  const runInvestigation = async () => {
    if (!modelConfig) {
      setInvestigationStatus("not_configured");
      setInvestigationError("");
      setShowModelConfig(true);
      return;
    }
    const requestId = ++investigationRequest.current;
    currentRunIdRef.current = null;
    setCurrentRunId(null);
    window.sessionStorage.removeItem("releaseguard:run-id");
    setInvestigationStatus("running");
    setInvestigation(null);
    setApprovalSnapshot(null);
    setApprovalDecisions([]);
    setGithubIssue(null);
    setStage("pending");
    setInvestigationError("");
    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "为什么 Android 7.3.0 发布后，优惠券领取成功率突然下降？",
          fixture: false,
          config: {
            provider: modelConfig.provider,
            baseUrl: modelConfig.baseUrl,
            model: modelConfig.model,
            apiKey: modelConfig.apiKey,
          },
        }),
      });
      const payload = await response.json() as InvestigationResult & { code?: string; error?: string };
      if (requestId !== investigationRequest.current) return;
      if (!response.ok) {
        if (payload.code === "MODEL_NOT_CONFIGURED") {
          setInvestigationStatus("not_configured");
          setShowModelConfig(true);
          return;
        }
        throw new Error(payload.error || `${modelConfig?.provider ?? "模型"} 调查请求失败`);
      }
      if (!acceptInvestigationResponse(payload, requestId, null)) return;
      notify(`${payload.provider} / ${payload.model} 已完成并持久化调查`);
    } catch (error) {
      if (requestId !== investigationRequest.current) return;
      setInvestigationStatus("error");
      setInvestigationError(error instanceof Error ? error.message : "网络异常，请稍后重试");
    }
  };
  const runFixtureDemo = async () => {
    const requestId = ++investigationRequest.current;
    currentRunIdRef.current = null;
    setCurrentRunId(null);
    window.sessionStorage.removeItem("releaseguard:run-id");
    setInvestigationStatus("running");
    setInvestigation(null);
    setApprovalSnapshot(null);
    setApprovalDecisions([]);
    setGithubIssue(null);
    setStage("pending");
    setInvestigationError("");
    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: "为什么 Android 7.3.0 发布后，优惠券领取成功率突然下降？",
          fixture: true,
        }),
      });
      const payload = await response.json() as InvestigationResult & { error?: string };
      if (requestId !== investigationRequest.current) return;
      if (!response.ok) throw new Error(payload.error || "Phase 2 演示运行失败");
      if (!acceptInvestigationResponse(payload, requestId, null)) return;
      notify("Phase 3 fixture 已完成：RiskEvent → AgentLoop → Hypothesis → WAITING_APPROVAL");
    } catch (error) {
      if (requestId !== investigationRequest.current) return;
      setInvestigationStatus("error");
      setInvestigationError(error instanceof Error ? error.message : "Phase 2 演示运行失败");
    }
  };
  const sendInvestigationMessage = async (
    intent: "EXPLAIN" | "INVESTIGATE" | "ADD_HYPOTHESIS",
    content: string,
  ) => {
    if (!investigation) return;
    const expectedRunId = investigation.runId;
    const requestGeneration = investigationRequest.current;
    setChatBusy(true);
    setInvestigationError("");
    try {
      const response = await fetch(`/api/investigations/${encodeURIComponent(investigation.runId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          intent,
          content,
          config: modelConfig ? {
            provider: modelConfig.provider,
            baseUrl: modelConfig.baseUrl,
            model: modelConfig.model,
            apiKey: modelConfig.apiKey,
          } : undefined,
        }),
      });
      const payload = await response.json() as InvestigationResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "Agent 消息处理失败");
      if (!acceptInvestigationResponse(payload, requestGeneration, expectedRunId)) return;
      notify(intent === "EXPLAIN" ? "Agent 已基于现有证据回复" : "Agent 已完成补充调查并持久化结果");
    } catch (error) {
      if (requestGeneration !== investigationRequest.current
        || currentRunIdRef.current !== expectedRunId) return;
      setInvestigationError(error instanceof Error ? error.message : "Agent 消息处理失败");
      notify(error instanceof Error ? error.message : "Agent 消息处理失败");
    } finally {
      setChatBusy(false);
    }
  };
  const reopenInvestigation = async () => {
    if (!investigation) return;
    const expectedRunId = investigation.runId;
    const requestGeneration = investigationRequest.current;
    setApprovalStatus("running");
    setApprovalError("");
    try {
      const response = await fetch(`/api/investigations/${encodeURIComponent(investigation.runId)}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          reason: "产品经理认为需要补充证据后再审批",
        }),
      });
      const payload = await response.json() as InvestigationResult & { error?: string };
      if (!response.ok) throw new Error(payload.error || "继续调查失败");
      if (!acceptInvestigationResponse(payload, requestGeneration, expectedRunId)) return;
      setView("incident");
      notify("旧审批快照已撤回；Run 已回到调查中");
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : "继续调查失败");
      return;
    } finally {
      setApprovalStatus("idle");
    }
  };
  const handleVerificationAction = async (
    action: "retry" | "reopen",
    verificationRunId: string,
  ) => {
    if (!investigation) return;
    const expectedRunId = investigation.runId;
    const requestGeneration = investigationRequest.current;
    try {
      const response = await fetch(
        `/api/investigations/${encodeURIComponent(investigation.runId)}/verifications/${encodeURIComponent(verificationRunId)}/${action}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientRequestId: crypto.randomUUID(),
            reason: action === "reopen" ? "产品经理要求基于验证结果重新调查" : undefined,
          }),
        },
      );
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || `Verification ${action} 失败`);
      const refreshed = await fetch(`/api/investigate?runId=${encodeURIComponent(investigation.runId)}`);
      if (!refreshed.ok) throw new Error("Verification 已更新，但刷新 Investigation 失败");
      const persisted = await refreshed.json() as InvestigationResult;
      if (!acceptInvestigationResponse(persisted, requestGeneration, expectedRunId)) return;
      notify(action === "retry" ? "已创建新的 Verification attempt" : "已重新进入 Investigation");
    } catch (error) {
      notify(error instanceof Error ? error.message : `Verification ${action} 失败`);
    }
  };
  const presentedInvestigation = canPresentCurrentInvestigation(
    investigationStatus,
    investigation,
    currentRunId,
  ) ? investigation : null;
  const activeEvidence = presentedInvestigation
    ? presentEvidence(presentedInvestigation.investigation.evidence)
    : [];

  return <main className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark">R</span><div><strong>上线风险中心</strong><small>ReleaseGuard AI</small></div></div><nav aria-label="主导航">{navItems.map((item) => <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => setView(item.id)}><span className="nav-glyph">{item.glyph}</span>{item.label}{item.id === "approval" && stage === "pending" && approvalSnapshot && <b className="nav-badge">1</b>}</button>)}</nav><div className="system-card"><span className="status-dot" /><div><strong>监控运行中</strong><small>4 个数据源已连接</small></div></div><div className="profile"><span>PM</span><div><strong>产品经理</strong><small>演示工作区</small></div></div></aside>
    <section className="workspace"><header className="topbar"><div><p className="eyebrow">RELEASE OPERATIONS</p><h1>{activeLabel}</h1><p>Detect → Investigate → Decide → Approve → Act → Verify</p></div><div className="top-actions"><span className="deployment-mode-badge">私有 Live 模式</span><button className={modelConfig ? "model-config-button connected" : "model-config-button"} onClick={() => setShowModelConfig(true)}><i />{modelConfig ? `${modelConfig.provider} · ${modelConfig.model}` : "配置模型服务"}</button><button className={githubConfig ? "model-config-button connected" : "model-config-button"} onClick={() => setShowGithubConfig(true)}><i />{githubConfig ? `GitHub · ${githubConfig.owner}/${githubConfig.repo}` : "配置集成"}</button><button className="reset-button" onClick={reset}>重置演示</button><button className="secondary-button" onClick={() => setLastUpdated("刚刚")}>↻ 刷新</button></div></header><section className="public-mode-notice"><b>PRIVATE_LIVE</b><span>仅限访问控制后的单一可信操作者；当前版本不提供多租户数据隔离。</span></section>{view === "overview" && <Overview onView={setView} investigation={presentedInvestigation} />}{view === "incident" && <Incident stage={stage} onView={setView} onAdvance={advance} onSubmitApproval={submitForApproval} hasApprovalSnapshot={Boolean(approvalSnapshot)} hasGithubIssue={Boolean(githubIssue)} investigationStatus={investigationStatus} investigation={investigation} currentRunId={currentRunId} investigationError={investigationError} runInvestigation={runInvestigation} runFixtureDemo={runFixtureDemo} activeConfig={modelConfig} onConfigure={() => setShowModelConfig(true)} onReset={reset} onSendMessage={sendInvestigationMessage} onVerificationAction={handleVerificationAction} chatBusy={chatBusy} />}{view === "approval" && <Approval key={approvalSnapshot?.submittedAt ?? "empty"} stage={stage} snapshot={approvalSnapshot} investigation={investigation} latestDecision={approvalDecisions.at(-1) ?? null} githubConfig={githubConfig} githubIssue={githubIssue} approvalStatus={approvalStatus} approvalError={approvalError} githubStatus={githubStatus} githubError={githubError} approve={approve} reject={reject} onInvestigate={() => setView("incident")} onConfigureGithub={() => setShowGithubConfig(true)} onCreateGithubIssue={createGithubIssue} onContinueInvestigation={reopenInvestigation} />}{view === "evidence" && <EvidenceView items={activeEvidence} />}{view === "audit" && <Audit stage={stage} snapshot={approvalSnapshot} decisions={approvalDecisions} githubIssue={githubIssue} workflowTimes={workflowTimes} investigation={investigation} />}</section>{showModelConfig && <ModelConfigModal initial={modelConfig} onClose={() => setShowModelConfig(false)} onSave={saveModelConfig} onClear={clearModelConfig} />}{showGithubConfig && <GithubConfigModal initial={githubConfig} onClose={() => setShowGithubConfig(false)} onSave={saveGithubConfig} onClear={clearGithubConfig} />}{toast && <div className="toast"><i>✓</i>{toast}</div>}</main>;
}

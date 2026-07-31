"use client";

import Link from "next/link";
import { useEffect, useReducer, useState } from "react";
import { BEST_PRACTICE_SCENARIO } from "@/lib/best-practice-scenario";
import {
  createPublicDemoReplayState,
  PUBLIC_DEMO_FIXTURE,
  PUBLIC_DEMO_LIMITS,
  publicDemoReplayReducer,
  selectPublicDemoReplay,
  type PublicDemoAuditEvent,
  type PublicDemoEvidenceRelation,
  type PublicDemoHypothesisStatus,
  type PublicDemoReplayMode,
  type PublicDemoReplayStage,
} from "@/lib/public-demo";

type DemoView = "overview" | "replay" | "architecture" | "safety";

const navigation: Array<{ id: DemoView; label: string; glyph: string }> = [
  { id: "overview", label: "业务概览", glyph: "▥" },
  { id: "replay", label: "Agent 执行详情", glyph: "▷" },
  { id: "architecture", label: "技术说明", glyph: "⌘" },
  { id: "safety", label: "安全边界", glyph: "◇" },
];

const stageLabels: Record<PublicDemoReplayStage, string> = {
  IDLE: "等待开始",
  DETECTED: "风险已检测",
  INVESTIGATING: "Agent 调查中",
  WAITING_APPROVAL: "等待人工审批",
  APPROVED: "已批准",
  ACTION_SIMULATED: "模拟工作项已创建",
  ACTION_COMPLETED: "动作已完成",
  VERIFIED: "验证通过",
};

const hypothesisLabels: Record<PublicDemoHypothesisStatus, string> = {
  ACTIVE: "调查中",
  SUPPORTED: "证据支持",
  WEAKENED: "证据减弱",
  REJECTED: "已排除",
  SELECTED: "已选定",
};

const relationLabels: Record<PublicDemoEvidenceRelation, string> = {
  SUPPORTS: "支持",
  CONTRADICTS: "反驳",
  NEUTRAL: "中性",
};

const phaseLabels: Record<string, string> = {
  Detect: "风险发现",
  Planner: "调查规划",
  Tool: "工具调用",
  Assessment: "证据判断",
  Diagnosis: "形成结论",
  "Human Approval": "人工审批",
  "Recoverable Action": "可恢复处置",
  "Action Completion": "动作完成",
  Verification: "恢复验证",
  "Fault Injection": "故障注入",
};

const decisionStatusLabels: Record<string, string> = {
  ACCEPTED: "已接受",
  REPAIRED: "已修正",
  REJECTED: "已拒绝",
};

const confidenceLabels: Record<string, string> = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
};

const auditTone: Record<PublicDemoAuditEvent["status"], string> = {
  OBSERVED: "observed",
  VALID: "valid",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  SUCCESS: "success",
};

function formatReplayTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = (seconds % 60).toString().padStart(2, "0");
  return `T+${minutes}:${remainder}`;
}

function BudgetMeter({ used, max, label }: { used: number; max: number; label: string }) {
  return <div className="replay-budget-meter">
    <div><span>{label}</span><b>{used} / {max}</b></div>
    <div className="replay-budget-track" aria-label={`${label} ${used}/${max}`}>
      <i style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
    </div>
  </div>;
}

function ReplayControls({
  mode,
  cursor,
  stepCount,
  playing,
  dispatch,
}: {
  mode: PublicDemoReplayMode;
  cursor: number;
  stepCount: number;
  playing: boolean;
  dispatch: React.Dispatch<Parameters<typeof publicDemoReplayReducer>[1]>;
}) {
  return <div className="replay-controls" aria-label="Agent 回放控制">
    <div className="replay-mode-switch" aria-label="回放路径">
      <button
        className={mode === "NORMAL" ? "active" : ""}
        data-testid="normal-replay-mode"
        onClick={() => dispatch({ type: "SET_MODE", mode: "NORMAL" })}
      >正常路径</button>
      <button
        className={mode === "FAULT_INJECTION" ? "active fault" : ""}
        data-testid="fault-replay-mode"
        onClick={() => dispatch({ type: "SET_MODE", mode: "FAULT_INJECTION" })}
      >故障注入</button>
    </div>
    <span className="replay-step-counter" aria-live="polite">
      {cursor < 0 ? "等待开始" : `${cursor + 1} / ${stepCount}`}
    </span>
    <div className="replay-command-group">
      <button
        aria-label="上一步"
        className="replay-icon-button"
        data-testid="replay-previous"
        disabled={cursor < 0}
        onClick={() => dispatch({ type: "PREVIOUS" })}
        title="上一步"
      >←</button>
      <button
        className="replay-command-button"
        data-testid="replay-autoplay"
        disabled={!playing && cursor >= stepCount - 1}
        onClick={() => dispatch({ type: playing ? "PAUSE" : "PLAY" })}
      ><span aria-hidden="true">{playing ? "Ⅱ" : "▶"}</span>{playing ? "暂停" : "自动播放"}</button>
      <button
        aria-label="下一步"
        className="replay-icon-button"
        data-testid="replay-next"
        disabled={cursor >= stepCount - 1}
        onClick={() => dispatch({ type: "NEXT" })}
        title="下一步"
      >→</button>
      <button
        className="replay-command-button reset"
        data-testid="replay-reset"
        onClick={() => dispatch({ type: "RESET" })}
      ><span aria-hidden="true">↺</span>重置本标签页</button>
    </div>
  </div>;
}

function ArchitectureView() {
  const architecture = [
    "调查规划（LLM Planner）",
    "类型化决策协议",
    "AgentLoop 执行约束",
    "只读工具",
    "证据与可能原因关系",
    "有依据的诊断",
    "人工审批",
    "可恢复处置",
    "恢复验证",
  ];
  return <div className="public-replay-secondary" data-testid="architecture-view">
    <section className="replay-section-heading">
      <span>技术架构</span>
      <h2>决策由模型提出，约束由服务端执行</h2>
      <p>公开演示回放与真实调查使用相同的产品概念，但不复制或调用真实运行环境。</p>
    </section>
    <div className="architecture-chain" aria-label="ReleaseGuard AI 架构链路">
      {architecture.map((item, index) => <div key={item}>
        <b>{index + 1}</b><span>{item}</span>{index < architecture.length - 1 && <i aria-hidden="true">→</i>}
      </div>)}
    </div>
    <section className="architecture-principles">
      <article><span>01</span><h3>调查规划</h3><p>提出多个可能原因、选择下一项调查工具，并给出公开说明；它不拥有预算或权限。</p></article>
      <article><span>02</span><h3>运行约束</h3><p>类型化协议、语义校验、模型和工具预算共同决定一次决策能否被正式接受。</p></article>
      <article><span>03</span><h3>证据关联</h3><p>工具结果先转化为证据，再以支持、反驳或中性关系连接到可能原因。</p></article>
      <article><span>04</span><h3>人工控制</h3><p>外部操作必须绑定具体审批；公开演示仅模拟幂等、可恢复的执行结果。</p></article>
    </section>
  </div>;
}

function SafetyView() {
  return <div className="public-replay-secondary" data-testid="safety-view">
    <section className="replay-section-heading">
      <span>公开演示边界</span>
      <h2>安全的确定性 Agent 执行回放</h2>
      <p>该页面不接受凭据，不共享调查状态，也不把静态演示数据伪装成实时模型输出。</p>
    </section>
    <section className="safety-zero-grid" aria-label="外部调用计数">
      <article><b>0</b><span>模型服务调用</span></article>
      <article><b>0</b><span>GitHub 调用</span></article>
      <article><b>0</b><span>D1 调查读写</span></article>
      <article><b>0</b><span>外部操作</span></article>
    </section>
    <section className="safety-boundary-list">
      <div><b>标签页内存</b><span>状态仅存在于当前组件内存；刷新和新标签页都会回到“等待开始”。</span></div>
      <div><b>服务端强制</b><span>真实调查、审批、GitHub、对话、继续调查与共享数据 API 在公开演示模式下继续返回脱敏 403。</span></div>
      <div><b>无凭据界面</b><span>页面不存在 API 密钥、访问令牌、仓库或自定义服务地址输入。</span></div>
      <div><b>模拟外部动作</b><span>唯一工作项是 DEMO-WORK-ITEM-001，不生成可点击的真实 GitHub Issue 链接。</span></div>
    </section>
  </div>;
}

function BusinessOverview({ onOpenDetails }: { onOpenDetails: () => void }) {
  const scenario = BEST_PRACTICE_SCENARIO;
  return <div className="public-business-overview" data-testid="business-overview">
    <section className="first-experience-callout" aria-labelledby="first-experience-heading">
      <div>
        <span>第一次体验？</span>
        <h2 id="first-experience-heading">3 分钟完成一次发布风险调查</h2>
        <p>不用先理解技术术语。跟随一个酒店业务事故，体验从异常发现、原因调查到人工决策和恢复验证的完整过程。</p>
      </div>
      <Link className="first-experience-button" data-testid="guided-experience-entry" href="/guided-experience">
        开始体验 <span aria-hidden="true">→</span>
      </Link>
    </section>

    <section className="business-incident-summary" aria-labelledby="business-incident-heading">
      <div className="business-incident-heading">
        <div><span>演示案例 · 非生产数据</span><h2 id="business-incident-heading">{scenario.title}</h2></div>
        <Link href="/best-practice">查看完整最佳实践 <span aria-hidden="true">→</span></Link>
      </div>
      <div className="business-metric-strip" aria-label="酒店案例关键指标">
        <div><span>发布前</span><b>{scenario.before.conversionRate}</b><small>酒店下单转化率</small></div>
        <div className="decline"><span>发布后约 2 小时</span><b>{scenario.after.conversionRate}</b><small>下降 {scenario.after.absoluteDecline} · 相对下降 {scenario.after.relativeDecline}</small></div>
        <div><span>风险为什么触发</span><b>相对降幅超过 {scenario.riskRule.declineThreshold}</b><small>并持续超过 {scenario.riskRule.durationThreshold}</small></div>
      </div>
      <p className="business-risk-explanation">相对降幅和持续时间均超过团队预设标准，因此系统开始调查。风险标准由业务团队提前设定，AI 负责发现异常后的调查。</p>
    </section>

    <section className="business-capability-flow" aria-labelledby="business-flow-heading">
      <div><span>ReleaseGuard AI 如何工作</span><h2 id="business-flow-heading">先理解业务过程，再按需查看技术细节</h2></div>
      <ol>
        {["发现指标异常", "提出可能原因", "收集支持与反驳证据", "给出处置建议", "等待负责人决策", "验证业务恢复"].map((item, index) =>
          <li key={item}><span>{index + 1}</span><b>{item}</b></li>)}
      </ol>
      <button data-testid="open-agent-details" onClick={onOpenDetails}>
        查看 Agent 执行详情 <span aria-hidden="true">→</span>
      </button>
    </section>
  </div>;
}

export default function PublicDemo() {
  const [view, setView] = useState<DemoView>("overview");
  const [state, dispatch] = useReducer(
    publicDemoReplayReducer,
    undefined,
    () => createPublicDemoReplayState(),
  );
  const snapshot = selectPublicDemoReplay(state);
  const current = snapshot.currentStep;
  const currentBudget = current?.budget ?? {
    ...PUBLIC_DEMO_LIMITS,
    modelCallsUsed: 0,
    toolCallsUsed: 0,
    iterationsUsed: 0,
  };

  useEffect(() => {
    if (state.playback !== "PLAYING") return;
    const timer = window.setInterval(() => dispatch({ type: "NEXT" }), 900);
    return () => window.clearInterval(timer);
  }, [state.playback]);

  return <main className="app-shell public-demo-shell">
    <aside className="sidebar public-replay-sidebar">
      <div className="brand"><span className="brand-mark">R</span><div><strong>ReleaseGuard AI</strong><small>发布风险智能</small></div></div>
      <nav aria-label="公开演示导航">
        {navigation.map((item) => <button
          key={item.id}
          className={view === item.id ? "nav-item active" : "nav-item"}
          data-testid={`demo-nav-${item.id}`}
          onClick={() => setView(item.id)}
        ><span className="nav-glyph">{item.glyph}</span>{item.label}</button>)}
        <Link className="nav-item" data-testid="best-practice-entry" href="/best-practice">
          <span className="nav-glyph">◎</span>最佳实践
        </Link>
      </nav>
      <div className="system-card"><span className="status-dot" /><div><strong>演示环境就绪</strong><small>静态案例 · 不触发外部操作</small></div></div>
      <div className="profile"><span>演示</span><div><strong>公开演示环境</strong><small>当前为演示数据，不会执行外部操作</small></div></div>
    </aside>

    <section className="workspace public-replay-workspace">
      <header className="public-replay-header">
        <div className="public-replay-heading">
          <div className="public-replay-labels"><span>公开演示</span><b>{view === "overview" ? "业务优先" : "技术详情"}</b></div>
          <h1>{view === "overview" ? "看懂一次发布风险调查" : view === "replay" ? "Agent 执行详情" : "ReleaseGuard AI 技术说明"}</h1>
          <p>{view === "overview"
            ? "从业务异常出发，了解 Agent 如何调查原因、提出建议并验证恢复。"
            : view === "replay"
              ? "安全的确定性执行记录，不调用真实模型、GitHub 或 D1。"
              : "按需查看执行记录、服务端约束与安全边界。"}</p>
        </div>
        <div className="public-replay-scenario">
          <span>{view === "overview" ? "新手案例" : "技术回放场景"}</span>
          <b>{view === "overview" ? BEST_PRACTICE_SCENARIO.title : PUBLIC_DEMO_FIXTURE.scenario}</b>
          <small>{view === "overview" ? "3 分钟业务引导" : stageLabels[snapshot.stage]}</small>
        </div>
      </header>

      {view === "replay" && <ReplayControls
        mode={state.mode}
        cursor={state.cursor}
        stepCount={snapshot.steps.length}
        playing={state.playback === "PLAYING"}
        dispatch={dispatch}
      />}

      {view === "replay" && state.mode === "FAULT_INJECTION" && <section className="fault-replay-notice" data-testid="fault-replay-notice">
        <b>故障注入回放</b>
        <span>显式注入一次不符合结构要求的响应，用于演示拒绝与有限修正；不代表真实模型服务事件。</span>
      </section>}

      {view === "architecture" && <ArchitectureView />}
      {view === "safety" && <SafetyView />}
      {view === "overview" && <BusinessOverview onOpenDetails={() => setView("replay")} />}

      {view === "replay" && <div className="public-replay-content" data-testid="agent-replay-view">
        <section className="replay-signal-band" aria-label="场景与预算">
          <div><span>指标信号</span><b>{PUBLIC_DEMO_FIXTURE.baseline} <i>→</i> {PUBLIC_DEMO_FIXTURE.observed}</b><small>{PUBLIC_DEMO_FIXTURE.metric}</small></div>
          <div><span>调查状态</span><b>{stageLabels[snapshot.stage]}</b><small>内部状态 {snapshot.stage}</small></div>
          <div><span>模型调用</span><b>{currentBudget.modelCallsUsed} / {currentBudget.maxModelCalls}</b><small>首次调用与修正共用预算</small></div>
          <div><span>只读工具调用</span><b>{currentBudget.toolCallsUsed} / {currentBudget.maxToolCalls}</b><small>服务端记录</small></div>
          <div><span>调查轮次</span><b>{currentBudget.iterationsUsed} / {currentBudget.maxIterations}</b><small>修正不增加调查轮次</small></div>
        </section>

        <section className="agent-replay-grid">
          <section className="replay-column execution-column" aria-labelledby="execution-heading">
            <div className="replay-column-heading"><div><span>Agent 执行过程</span><h2 id="execution-heading">逐轮执行</h2></div><b>{snapshot.steps.length} 步</b></div>
            <div className="execution-list" data-testid="execution-list">
              {snapshot.steps.map((step, index) => {
                const stateClass = index === state.cursor ? "current" : index < state.cursor ? "complete" : "pending";
                return <article className={`execution-row ${stateClass} ${step.decision?.status === "REJECTED" ? "rejected" : ""}`} data-step-id={step.id} key={step.id}>
                  <div className="execution-index"><span>{(index + 1).toString().padStart(2, "0")}</span><i /></div>
                  <div className="execution-copy">
                    <div><b>{phaseLabels[step.phase] ?? step.phase}</b><span>{step.iteration ? `第 ${step.iteration} 轮` : stageLabels[step.stage]}</span></div>
                    <h3>{step.decision?.type ?? step.title}</h3>
                    <p>{step.title}</p>
                    <div className="execution-meta">
                      {step.decision && <span>模型调用 #{step.decision.modelCallOrdinal}</span>}
                      {step.toolCall && <span>{step.toolCall.name}</span>}
                      {step.decision && <em className={step.decision.status.toLowerCase()}>{decisionStatusLabels[step.decision.status] ?? step.decision.status}</em>}
                    </div>
                  </div>
                </article>;
              })}
            </div>
          </section>

          <section className="replay-column matrix-column" aria-labelledby="matrix-heading">
            <div className="replay-column-heading"><div><span>可能原因与证据</span><h2 id="matrix-heading">调查方向</h2></div><b>{snapshot.relations.length} 条关联</b></div>
            {snapshot.hypotheses.length === 0 ? <div className="replay-empty" data-testid="hypothesis-empty">
              <b>尚未形成可能原因</b><span>风险发现后，Agent 会先定义多个调查方向以及支持、反驳条件。</span>
            </div> : <div className="replay-hypotheses" data-testid="hypothesis-matrix">
              {snapshot.hypotheses.map((item) => <article className={`replay-hypothesis ${item.status.toLowerCase()}`} key={item.id}>
                <div><span>{item.id}</span><b>{hypothesisLabels[item.status]}</b></div>
                <h3>{item.statement}</h3>
                <dl><div><dt>支持条件</dt><dd>{item.supportIf}</dd></div><div><dt>反驳条件</dt><dd>{item.refuteIf}</dd></div></dl>
              </article>)}
            </div>}

            <div className="evidence-matrix-heading"><span>证据矩阵</span><b>已收集 {snapshot.evidence.length} / 3</b></div>
            {snapshot.evidence.length === 0 ? <div className="replay-empty compact" data-testid="evidence-empty">
              <b>暂无证据</b><span>只有成功的工具结果才能生成对应证据。</span>
            </div> : <div className="evidence-matrix" data-testid="evidence-matrix">
              <div className="evidence-matrix-head"><span>证据 / 来源</span><span>可能原因</span><span>关系</span></div>
              {snapshot.evidence.flatMap((item) => {
                const linked = snapshot.relations.filter((relation) => relation.evidenceId === item.id);
                if (linked.length === 0) return <div className="evidence-matrix-row unassessed" key={item.id}>
                  <div><b>{item.title}</b><small>{item.sourceTool}</small></div><span>等待证据判断</span><em>尚未判断</em>
                </div>;
                return linked.map((relation) => <div className="evidence-matrix-row" key={`${item.id}-${relation.targetHypothesisId}`}>
                  <div><b>{item.title}</b><small>{item.sourceTool} · {item.provenance}</small></div>
                  <div><b>{relation.targetHypothesisId}</b><small>{relation.explanation}</small></div>
                  <em className={relation.relation.toLowerCase()}>{relationLabels[relation.relation]}</em>
                </div>);
              })}
            </div>}

            {snapshot.diagnosis && <section className="replay-diagnosis" data-testid="grounded-diagnosis">
              <div><span>有依据的调查结论</span><b>可信度：{confidenceLabels[snapshot.diagnosis.confidence] ?? snapshot.diagnosis.confidence}</b></div>
              <h3>{snapshot.diagnosis.rootCause}</h3>
              <p>{snapshot.diagnosis.causalChain}</p>
              <small>{snapshot.diagnosis.proposedAction}</small>
            </section>}
          </section>

          <aside className="replay-column inspector-column" aria-labelledby="inspector-heading">
            <div className="replay-column-heading"><div><span>调查详情</span><h2 id="inspector-heading">当前事件</h2></div>{current && <b>第 {current.sequence + 1} 步</b>}</div>
            {!current ? <div className="replay-empty inspector-empty" data-testid="inspector-idle">
              <b>Agent 调查回放</b>
              <span>从风险发现开始，查看调查规划、工具结果、证据关系和服务端约束。</span>
              <button className="replay-start-button" onClick={() => dispatch({ type: "NEXT" })}>开始回放 <span>→</span></button>
            </div> : <div className="inspector-content" data-testid="agent-inspector">
              <div className="inspector-title"><span>{phaseLabels[current.phase] ?? current.phase}</span><h3>{current.title}</h3><p>{current.summary}</p></div>

              {current.decision ? <>
                <dl className="inspector-facts">
                  <div><dt>规划决策</dt><dd>{current.decision.type}</dd></div>
                  <div><dt>规划状态</dt><dd className={current.decision.status.toLowerCase()}>{current.decision.plannerState}</dd></div>
                  <div><dt>调查轮次 / 模型调用</dt><dd>{current.iteration} / #{current.decision.modelCallOrdinal}</dd></div>
                  <div><dt>结构 / 语义校验</dt><dd>{current.decision.validation.schema} / {current.decision.validation.semantic}</dd></div>
                </dl>
                <section className="inspector-block server-fact"><span>服务端确认的决策摘要</span><p>{current.decision.serverSummary}</p></section>
                <section className="inspector-block planner-note"><span>Agent 公开说明 · 非系统事实</span><p>{current.decision.publicRationale}</p></section>
                {current.decision.validation.code && <section className="inspector-block validation-error">
                  <span>{current.decision.validation.errorType}</span>
                  <code>{current.decision.validation.code}</code>
                  <small>path: {current.decision.validation.path}</small>
                </section>}
              </> : <section className="inspector-block server-fact"><span>结构化回放事件</span><p>该事件由确定性状态机推进，不包含模型决策。</p></section>}

              {current.toolCall && <>
                <section className="inspector-block tool-summary"><span>工具参数 · 安全摘要</span><b>{current.toolCall.name}</b><p>{current.toolCall.argumentsSummary}</p></section>
                <section className="inspector-block tool-summary result"><span>工具结果 · 安全摘要</span><b>{current.toolCall.status}</b><p>{current.toolCall.resultSummary}</p></section>
              </>}

              <div className="inspector-budgets">
                <BudgetMeter label="模型调用" used={current.budget.modelCallsUsed} max={current.budget.maxModelCalls} />
                <BudgetMeter label="只读工具调用" used={current.budget.toolCallsUsed} max={current.budget.maxToolCalls} />
              </div>

              <section className="inspector-objects"><span>本轮业务对象</span>{current.businessObjects.length > 0
                ? <ul>{current.businessObjects.map((item) => <li key={item}>{item}</li>)}</ul>
                : <p>无。被拒绝的决策不产生工具调用或业务产物。</p>}
              </section>

              {(snapshot.workItemReference || snapshot.verificationRate) && <section className="inspector-outcome">
                {snapshot.workItemReference && <div><span>本地工作项</span><b>{snapshot.workItemReference}</b><small>无外部链接</small></div>}
                {snapshot.verificationRate && <div><span>恢复观察窗口</span><b>{snapshot.verificationRate}</b><small>静态演示数据</small></div>}
              </section>}
              <footer>不展示提示词、原始模型响应、凭据、请求头或敏感字段。</footer>
            </div>}
          </aside>
        </section>

        <section className="replay-audit" aria-labelledby="audit-heading" data-testid="audit-timeline">
          <div className="replay-section-heading inline"><div><span>审计时间线</span><h2 id="audit-heading">确定性执行时间线</h2></div><b>稳定顺序 · 固定排序规则</b></div>
          {snapshot.auditEvents.length === 0 ? <div className="replay-empty compact"><b>暂无审计事件</b><span>回放推进后按稳定序列显示。</span></div> : <div className="replay-audit-list">
            {snapshot.auditEvents.map((event) => <article key={event.id}>
              <time>{formatReplayTime(event.offsetSeconds)}</time>
              <i className={auditTone[event.status]} />
              <div><b>{event.kind}</b><span>{event.label}</span></div>
              <em>{event.source}</em>
            </article>)}
          </div>}
        </section>
      </div>}
    </section>
  </main>;
}

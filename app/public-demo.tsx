"use client";

import { useEffect, useReducer, useState } from "react";
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

type DemoView = "replay" | "architecture" | "safety";

const navigation: Array<{ id: DemoView; label: string; glyph: string }> = [
  { id: "replay", label: "Agent 回放", glyph: "▷" },
  { id: "architecture", label: "架构说明", glyph: "⌘" },
  { id: "safety", label: "安全边界", glyph: "◇" },
];

const stageLabels: Record<PublicDemoReplayStage, string> = {
  IDLE: "等待开始",
  DETECTED: "风险已检测",
  INVESTIGATING: "Agent 调查中",
  WAITING_APPROVAL: "等待人工审批",
  APPROVED: "已批准",
  ACTION_SIMULATED: "模拟工作项已创建",
  ACTION_COMPLETED: "Action Completion",
  VERIFIED: "VERIFIED",
};

const hypothesisLabels: Record<PublicDemoHypothesisStatus, string> = {
  ACTIVE: "ACTIVE",
  SUPPORTED: "SUPPORTED",
  WEAKENED: "WEAKENED",
  REJECTED: "REJECTED",
  SELECTED: "SELECTED",
};

const relationLabels: Record<PublicDemoEvidenceRelation, string> = {
  SUPPORTS: "SUPPORTS",
  CONTRADICTS: "CONTRADICTS",
  NEUTRAL: "NEUTRAL",
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
  return <div className="replay-controls" aria-label="Agent replay 控制">
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
      {cursor < 0 ? "IDLE" : `${cursor + 1} / ${stepCount}`}
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
    "LLM Planner",
    "Typed Decision Contract",
    "AgentLoop",
    "Read-only Tools",
    "Evidence / Hypothesis Graph",
    "Grounded Diagnosis",
    "Human Approval",
    "Recoverable Action",
    "Verification",
  ];
  return <div className="public-replay-secondary" data-testid="architecture-view">
    <section className="replay-section-heading">
      <span>ARCHITECTURE</span>
      <h2>决策由模型提出，约束由服务端执行</h2>
      <p>Public Demo 回放与 Private Live 使用相同的产品概念，但不复制或调用真实 Runtime。</p>
    </section>
    <div className="architecture-chain" aria-label="ReleaseGuard AI 架构链路">
      {architecture.map((item, index) => <div key={item}>
        <b>{index + 1}</b><span>{item}</span>{index < architecture.length - 1 && <i aria-hidden="true">→</i>}
      </div>)}
    </div>
    <section className="architecture-principles">
      <article><span>01</span><h3>Planner 提议</h3><p>形成竞争假设、选择下一项调查工具，并输出公开 rationale；它不拥有预算或权限。</p></article>
      <article><span>02</span><h3>Runtime 约束</h3><p>Typed contract、语义校验、模型和工具预算决定 decision 能否被正式接受。</p></article>
      <article><span>03</span><h3>Evidence 证明</h3><p>ToolResult 先转化为 Evidence，再通过 SUPPORTS 或 CONTRADICTS 连接到 Hypothesis。</p></article>
      <article><span>04</span><h3>Human 保留控制</h3><p>外部 Action 必须绑定具体审批；Public Demo 仅模拟幂等、可恢复的执行结果。</p></article>
    </section>
  </div>;
}

function SafetyView() {
  return <div className="public-replay-secondary" data-testid="safety-view">
    <section className="replay-section-heading">
      <span>PUBLIC DEMO BOUNDARY</span>
      <h2>安全的确定性 Agent 执行回放</h2>
      <p>该页面不接受凭据，不共享调查状态，也不把 fixture 伪装成实时 Provider 输出。</p>
    </section>
    <section className="safety-zero-grid" aria-label="外部调用计数">
      <article><b>0</b><span>模型 Provider 调用</span></article>
      <article><b>0</b><span>GitHub 调用</span></article>
      <article><b>0</b><span>D1 调查读写</span></article>
      <article><b>0</b><span>外部 Action</span></article>
    </section>
    <section className="safety-boundary-list">
      <div><b>标签页内存</b><span>状态仅存在于当前组件内存；刷新和新标签页从 IDLE 开始。</span></div>
      <div><b>服务端强制</b><span>真实调查、审批、GitHub、chat、continue 与共享数据 API 在 PUBLIC_DEMO 下继续返回脱敏 403。</span></div>
      <div><b>无凭据界面</b><span>页面不存在 API Key、Token、仓库或自定义 Base URL 输入。</span></div>
      <div><b>模拟外部动作</b><span>唯一工作项是 DEMO-WORK-ITEM-001，不生成可点击的真实 Issue 链接。</span></div>
    </section>
  </div>;
}

export default function PublicDemo() {
  const [view, setView] = useState<DemoView>("replay");
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
      <div className="brand"><span className="brand-mark">R</span><div><strong>ReleaseGuard AI</strong><small>RELEASE INTELLIGENCE</small></div></div>
      <nav aria-label="公开演示导航">
        {navigation.map((item) => <button
          key={item.id}
          className={view === item.id ? "nav-item active" : "nav-item"}
          data-testid={`demo-nav-${item.id}`}
          onClick={() => setView(item.id)}
        ><span className="nav-glyph">{item.glyph}</span>{item.label}</button>)}
      </nav>
      <div className="system-card"><span className="status-dot" /><div><strong>确定性回放就绪</strong><small>0 外部调用 · 0 共享数据</small></div></div>
      <div className="profile"><span>DEMO</span><div><strong>PUBLIC_DEMO</strong><small>当前标签页内存</small></div></div>
    </aside>

    <section className="workspace public-replay-workspace">
      <header className="public-replay-header">
        <div className="public-replay-heading">
          <div className="public-replay-labels"><span>PUBLIC_DEMO</span><b>CURATED AGENT REPLAY</b></div>
          <h1>ReleaseGuard AI 决策回放</h1>
          <p>安全的确定性执行记录，不调用真实模型、GitHub 或 D1。</p>
        </div>
        <div className="public-replay-scenario">
          <span>当前 Scenario</span>
          <b>{PUBLIC_DEMO_FIXTURE.scenario}</b>
          <small>{stageLabels[snapshot.stage]}</small>
        </div>
      </header>

      <ReplayControls
        mode={state.mode}
        cursor={state.cursor}
        stepCount={snapshot.steps.length}
        playing={state.playback === "PLAYING"}
        dispatch={dispatch}
      />

      {state.mode === "FAULT_INJECTION" && <section className="fault-replay-notice" data-testid="fault-replay-notice">
        <b>FAULT-INJECTION REPLAY</b>
        <span>显式注入一次 schema-invalid 响应，用于演示 typed rejection 与 bounded repair；不代表本轮真实 Provider 事件。</span>
      </section>}

      {view === "architecture" && <ArchitectureView />}
      {view === "safety" && <SafetyView />}

      {view === "replay" && <div className="public-replay-content" data-testid="agent-replay-view">
        <section className="replay-signal-band" aria-label="场景与预算">
          <div><span>Metric signal</span><b>{PUBLIC_DEMO_FIXTURE.baseline} <i>→</i> {PUBLIC_DEMO_FIXTURE.observed}</b><small>{PUBLIC_DEMO_FIXTURE.metric}</small></div>
          <div><span>Run state</span><b>{snapshot.stage}</b><small>{stageLabels[snapshot.stage]}</small></div>
          <div><span>Model calls</span><b>{currentBudget.modelCallsUsed} / {currentBudget.maxModelCalls}</b><small>initial 与 repair 共用预算</small></div>
          <div><span>Read-only tools</span><b>{currentBudget.toolCallsUsed} / {currentBudget.maxToolCalls}</b><small>服务端事实</small></div>
          <div><span>Iterations</span><b>{currentBudget.iterationsUsed} / {currentBudget.maxIterations}</b><small>repair 不增加 iteration</small></div>
        </section>

        <section className="agent-replay-grid">
          <section className="replay-column execution-column" aria-labelledby="execution-heading">
            <div className="replay-column-heading"><div><span>AGENT EXECUTION</span><h2 id="execution-heading">逐轮执行</h2></div><b>{snapshot.steps.length} STEPS</b></div>
            <div className="execution-list" data-testid="execution-list">
              {snapshot.steps.map((step, index) => {
                const stateClass = index === state.cursor ? "current" : index < state.cursor ? "complete" : "pending";
                return <article className={`execution-row ${stateClass} ${step.decision?.status === "REJECTED" ? "rejected" : ""}`} data-step-id={step.id} key={step.id}>
                  <div className="execution-index"><span>{(index + 1).toString().padStart(2, "0")}</span><i /></div>
                  <div className="execution-copy">
                    <div><b>{step.phase}</b><span>{step.iteration ? `Iteration ${step.iteration}` : step.stage}</span></div>
                    <h3>{step.decision?.type ?? step.title}</h3>
                    <p>{step.title}</p>
                    <div className="execution-meta">
                      {step.decision && <span>Model #{step.decision.modelCallOrdinal}</span>}
                      {step.toolCall && <span>{step.toolCall.name}</span>}
                      {step.decision && <em className={step.decision.status.toLowerCase()}>{step.decision.status}</em>}
                    </div>
                  </div>
                </article>;
              })}
            </div>
          </section>

          <section className="replay-column matrix-column" aria-labelledby="matrix-heading">
            <div className="replay-column-heading"><div><span>HYPOTHESIS + EVIDENCE</span><h2 id="matrix-heading">竞争假设与证据矩阵</h2></div><b>{snapshot.relations.length} LINKS</b></div>
            {snapshot.hypotheses.length === 0 ? <div className="replay-empty" data-testid="hypothesis-empty">
              <b>尚未创建竞争假设</b><span>Detect 后，Planner 将先定义支持与反驳条件。</span>
            </div> : <div className="replay-hypotheses" data-testid="hypothesis-matrix">
              {snapshot.hypotheses.map((item) => <article className={`replay-hypothesis ${item.status.toLowerCase()}`} key={item.id}>
                <div><span>{item.id}</span><b>{hypothesisLabels[item.status]}</b></div>
                <h3>{item.statement}</h3>
                <dl><div><dt>支持条件</dt><dd>{item.supportIf}</dd></div><div><dt>反驳条件</dt><dd>{item.refuteIf}</dd></div></dl>
              </article>)}
            </div>}

            <div className="evidence-matrix-heading"><span>EVIDENCE MATRIX</span><b>{snapshot.evidence.length} / 3 collected</b></div>
            {snapshot.evidence.length === 0 ? <div className="replay-empty compact" data-testid="evidence-empty">
              <b>暂无 Evidence</b><span>只有成功 ToolResult 才能生成对应 Evidence。</span>
            </div> : <div className="evidence-matrix" data-testid="evidence-matrix">
              <div className="evidence-matrix-head"><span>Evidence / Source</span><span>Hypothesis</span><span>Relation</span></div>
              {snapshot.evidence.flatMap((item) => {
                const linked = snapshot.relations.filter((relation) => relation.evidenceId === item.id);
                if (linked.length === 0) return <div className="evidence-matrix-row unassessed" key={item.id}>
                  <div><b>{item.title}</b><small>{item.sourceTool}</small></div><span>等待 ASSESS_EVIDENCE</span><em>UNASSESSED</em>
                </div>;
                return linked.map((relation) => <div className="evidence-matrix-row" key={`${item.id}-${relation.targetHypothesisId}`}>
                  <div><b>{item.title}</b><small>{item.sourceTool} · {item.provenance}</small></div>
                  <div><b>{relation.targetHypothesisId}</b><small>{relation.explanation}</small></div>
                  <em className={relation.relation.toLowerCase()}>{relationLabels[relation.relation]}</em>
                </div>);
              })}
            </div>}

            {snapshot.diagnosis && <section className="replay-diagnosis" data-testid="grounded-diagnosis">
              <div><span>GROUNDED DIAGNOSIS</span><b>{snapshot.diagnosis.confidence}</b></div>
              <h3>{snapshot.diagnosis.rootCause}</h3>
              <p>{snapshot.diagnosis.causalChain}</p>
              <small>{snapshot.diagnosis.proposedAction}</small>
            </section>}
          </section>

          <aside className="replay-column inspector-column" aria-labelledby="inspector-heading">
            <div className="replay-column-heading"><div><span>AGENT INSPECTOR</span><h2 id="inspector-heading">当前事件</h2></div>{current && <b>STEP {current.sequence + 1}</b>}</div>
            {!current ? <div className="replay-empty inspector-empty" data-testid="inspector-idle">
              <b>CURATED AGENT REPLAY</b>
              <span>从 Detect 开始查看 Planner decision、工具结果、Evidence relation 和服务端约束。</span>
              <button className="replay-start-button" onClick={() => dispatch({ type: "NEXT" })}>开始回放 <span>→</span></button>
            </div> : <div className="inspector-content" data-testid="agent-inspector">
              <div className="inspector-title"><span>{current.phase}</span><h3>{current.title}</h3><p>{current.summary}</p></div>

              {current.decision ? <>
                <dl className="inspector-facts">
                  <div><dt>Planner decision</dt><dd>{current.decision.type}</dd></div>
                  <div><dt>Planner state</dt><dd className={current.decision.status.toLowerCase()}>{current.decision.plannerState}</dd></div>
                  <div><dt>Iteration / model call</dt><dd>{current.iteration} / #{current.decision.modelCallOrdinal}</dd></div>
                  <div><dt>Schema / semantic</dt><dd>{current.decision.validation.schema} / {current.decision.validation.semantic}</dd></div>
                </dl>
                <section className="inspector-block server-fact"><span>服务端认可的 Decision Summary</span><p>{current.decision.serverSummary}</p></section>
                <section className="inspector-block planner-note"><span>Planner 公开 rationale · 非系统事实</span><p>{current.decision.publicRationale}</p></section>
                {current.decision.validation.code && <section className="inspector-block validation-error">
                  <span>{current.decision.validation.errorType}</span>
                  <code>{current.decision.validation.code}</code>
                  <small>path: {current.decision.validation.path}</small>
                </section>}
              </> : <section className="inspector-block server-fact"><span>结构化 replay event</span><p>该事件由确定性状态机推进，不包含模型 decision。</p></section>}

              {current.toolCall && <>
                <section className="inspector-block tool-summary"><span>Tool arguments · 安全摘要</span><b>{current.toolCall.name}</b><p>{current.toolCall.argumentsSummary}</p></section>
                <section className="inspector-block tool-summary result"><span>ToolResult · 安全摘要</span><b>{current.toolCall.status}</b><p>{current.toolCall.resultSummary}</p></section>
              </>}

              <div className="inspector-budgets">
                <BudgetMeter label="Model calls" used={current.budget.modelCallsUsed} max={current.budget.maxModelCalls} />
                <BudgetMeter label="Read-only tools" used={current.budget.toolCallsUsed} max={current.budget.maxToolCalls} />
              </div>

              <section className="inspector-objects"><span>本轮业务对象</span>{current.businessObjects.length > 0
                ? <ul>{current.businessObjects.map((item) => <li key={item}>{item}</li>)}</ul>
                : <p>无。被拒绝的 decision 不产生 ToolCall 或业务产物。</p>}
              </section>

              {(snapshot.workItemReference || snapshot.verificationRate) && <section className="inspector-outcome">
                {snapshot.workItemReference && <div><span>Local work item</span><b>{snapshot.workItemReference}</b><small>无外部链接</small></div>}
                {snapshot.verificationRate && <div><span>Recovery window</span><b>{snapshot.verificationRate}</b><small>STATIC FIXTURE</small></div>}
              </section>}
              <footer>不展示 prompt、原始模型响应、凭据、Header 或敏感字段。</footer>
            </div>}
          </aside>
        </section>

        <section className="replay-audit" aria-labelledby="audit-heading" data-testid="audit-timeline">
          <div className="replay-section-heading inline"><div><span>AUDIT TIMELINE</span><h2 id="audit-heading">确定性执行时间线</h2></div><b>STABLE ORDER · TIE-BREAKER</b></div>
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

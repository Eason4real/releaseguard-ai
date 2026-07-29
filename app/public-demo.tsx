"use client";

import React, { useState } from "react";
import {
  createPublicDemoState,
  PUBLIC_DEMO_FIXTURE,
  publicDemoAuditRows,
  transitionPublicDemo,
  type PublicDemoEvent,
  type PublicDemoStage,
} from "@/lib/public-demo";

type DemoView = "overview" | "investigation" | "approval" | "evidence" | "audit";

const stageRank: Record<PublicDemoStage, number> = {
  IDLE: 0,
  INVESTIGATED: 3,
  APPROVED: 4,
  ACTION_SIMULATED: 5,
  ACTION_COMPLETED: 5,
  VERIFIED: 6,
};

const stageLabels: Record<PublicDemoStage, string> = {
  IDLE: "等待开始",
  INVESTIGATED: "等待审批",
  APPROVED: "已批准",
  ACTION_SIMULATED: "模拟工作项已创建",
  ACTION_COMPLETED: "Action Completion 已确认",
  VERIFIED: "验证完成",
};

const navigation: Array<[DemoView, string, string]> = [
  ["overview", "风险总览", "▥"],
  ["investigation", "事件调查", "⌕"],
  ["approval", "审批与 Action", "✓"],
  ["evidence", "证据库", "◇"],
  ["audit", "演示审计", "≡"],
];

function DemoFlow({ stage }: { stage: PublicDemoStage }) {
  const rank = stageRank[stage];
  return <div className="status-flow">{[
    "Detect", "Investigate", "Diagnosis", "Approval", "Simulated Action", "Verification",
  ].map((label, index) => <div className={index < rank ? "flow-step active" : "flow-step"} key={label}>
    <i>{index < rank ? "✓" : index + 1}</i><span>{label}</span>
  </div>)}</div>;
}

function DemoEvidence() {
  return <div className="demo-evidence-list">{PUBLIC_DEMO_FIXTURE.evidence.map(([label, source, detail]) =>
    <article key={label}><span>✓</span><div><b>{label}</b><p>{detail}</p><small>{source} · STATIC FIXTURE</small></div></article>)}</div>;
}

export default function PublicDemo() {
  const [view, setView] = useState<DemoView>("overview");
  const [state, setState] = useState(createPublicDemoState);
  const investigated = stageRank[state.stage] >= stageRank.INVESTIGATED;
  const auditRows = publicDemoAuditRows(state);

  const advance = (event: PublicDemoEvent, nextView?: DemoView) => {
    setState((current) => transitionPublicDemo(current, event));
    if (nextView) setView(nextView);
  };
  const reset = () => {
    setState(createPublicDemoState());
    setView("overview");
  };

  return <main className="app-shell public-demo-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">R</span><div><strong>上线风险中心</strong><small>ReleaseGuard AI</small></div></div>
      <nav aria-label="公开演示导航">{navigation.map(([id, label, glyph]) =>
        <button key={id} className={view === id ? "nav-item active" : "nav-item"} onClick={() => setView(id)}>
          <span className="nav-glyph">{glyph}</span>{label}
        </button>)}</nav>
      <div className="system-card"><span className="status-dot" /><div><strong>静态演示就绪</strong><small>无共享数据与外部调用</small></div></div>
      <div className="profile"><span>DEMO</span><div><strong>公开访客</strong><small>标签页内存状态</small></div></div>
    </aside>
    <section className="workspace">
      <header className="topbar public-demo-topbar"><div><p className="eyebrow">RELEASE OPERATIONS</p><h1>{navigation.find(([id]) => id === view)?.[1]}</h1><p>Detect → Investigate → Decide → Approve → Simulate → Verify</p></div><div className="top-actions"><span className="deployment-mode-badge public">公开演示模式</span><button className="reset-button" onClick={reset}>重置本标签页</button></div></header>
      <section className="public-mode-notice" aria-label="公开演示模式说明"><b>PUBLIC_DEMO</b><span>所有内容来自静态 fixture；状态仅保存在当前标签页内存，不读取 D1，不调用模型或 GitHub。</span></section>

      {view === "overview" && <div className="content">
        <section className="panel flow-panel"><div className="panel-heading"><div><span className="section-kicker">DETERMINISTIC RELEASE SCENARIO</span><h2>Android 7.3.0 发布风险演示</h2></div><span className={state.stage === "VERIFIED" ? "success-pill" : "pending-pill"}>{stageLabels[state.stage]}</span></div><DemoFlow stage={state.stage} /></section>
        <section className="dashboard-grid"><article className="panel metric-panel"><div className="panel-heading"><div><span className="section-kicker">METRIC ANOMALY · STATIC FIXTURE</span><h2>{PUBLIC_DEMO_FIXTURE.metric}</h2></div></div><div className="demo-metric"><div><small>动态基线</small><b>{PUBLIC_DEMO_FIXTURE.baseline}</b></div><span>→</span><div><small>当前观测</small><b>{PUBLIC_DEMO_FIXTURE.observed}</b></div></div></article>
          <article className="panel incident-card"><div className="incident-title"><span className="risk-pill">演示风险</span><span className="pending-pill">{stageLabels[state.stage]}</span></div><h2>优惠券领取成功率异常</h2><p>这是可重复的本地产品场景，不代表真实生产事故。</p>{!investigated ? <button className="primary-button" onClick={() => advance("RUN_INVESTIGATION", "investigation")}>运行公开演示 <span>→</span></button> : <button className="primary-button" onClick={() => setView("investigation")}>查看调查结果 <span>→</span></button>}</article></section>
      </div>}

      {view === "investigation" && <div className="content detail-page">
        <section className="panel flow-panel"><div className="panel-heading"><div><span className="section-kicker">STATIC INVESTIGATION</span><h2>Deterministic Planner 调查</h2></div><span className="deployment-mode-badge public">无模型调用</span></div><DemoFlow stage={state.stage} /></section>
        {!investigated ? <section className="panel demo-empty"><h2>调查尚未开始</h2><p>一键运行静态 fixture，生成 Hypothesis、Evidence 和 Diagnosis。</p><button className="primary-button" onClick={() => advance("RUN_INVESTIGATION")}>运行演示</button></section> : <>
          <section className="detail-grid"><article className="panel investigation-panel"><div className="panel-heading"><div><span className="section-kicker">HYPOTHESIS BOARD</span><h2>竞争假设</h2></div><span className="success-pill">DETERMINISTIC</span></div><div className="hypothesis-list">{PUBLIC_DEMO_FIXTURE.hypotheses.map((item) => <article className={`hypothesis-card ${item.status === "SUPPORTED" ? "leading" : "weakened"}`} key={item.title}><div><span>Fixture hypothesis</span><b>{item.status}</b></div><h3>{item.title}</h3><p>{item.detail}</p></article>)}</div></article>
            <aside className="panel decision-panel"><span className="section-kicker">GROUNDED DIAGNOSIS</span><h2>调查结论</h2><div className="score-ring" style={{ "--score": "324deg" } as React.CSSProperties}><strong>HIGH</strong><small>fixture confidence</small></div><div className="root-cause"><small>根因判断</small><p>{PUBLIC_DEMO_FIXTURE.diagnosis}</p></div><h3>{PUBLIC_DEMO_FIXTURE.recommendation}</h3><button className="primary-button" onClick={() => setView("approval")}>进入模拟审批 <span>→</span></button></aside></section>
          <section className="panel evidence-panel"><div className="evidence-header"><div><span className="section-kicker">EVIDENCE CHAIN</span><h2>静态证据</h2></div><button className="text-button" onClick={() => setView("evidence")}>查看完整证据链 →</button></div><DemoEvidence /></section>
        </>}
      </div>}

      {view === "approval" && <div className="content detail-page"><section className="panel flow-panel"><div className="panel-heading"><div><span className="section-kicker">LOCAL DEMO WORKFLOW</span><h2>审批、模拟 Action 与 Verification</h2></div><span className="pending-pill">{stageLabels[state.stage]}</span></div><DemoFlow stage={state.stage} /></section>
        {!investigated ? <section className="panel demo-empty"><h2>暂无待审批方案</h2><button className="primary-button" onClick={() => setView("investigation")}>先运行调查</button></section> : <section className="demo-action-sequence">
          <article className={stageRank[state.stage] >= 4 ? "panel demo-step complete" : "panel demo-step current"}><span>1</span><div><h3>人工审批</h3><p>审批只改变当前标签页内存状态。</p></div><button className="primary-button" disabled={state.stage !== "INVESTIGATED"} onClick={() => advance("APPROVE")}>{stageRank[state.stage] >= 4 ? "已批准" : "批准模拟方案"}</button></article>
          <article className={stageRank[state.stage] >= 5 ? "panel demo-step complete" : state.stage === "APPROVED" ? "panel demo-step current" : "panel demo-step"}><span>2</span><div><h3>模拟创建工作项</h3><p>生成本地引用 {PUBLIC_DEMO_FIXTURE.workItemReference}，不生成 URL，不调用 GitHub。</p></div><button className="primary-button" disabled={state.stage !== "APPROVED"} onClick={() => advance("SIMULATE_ACTION")}>{stageRank[state.stage] >= 5 ? "模拟工作项已创建" : "模拟创建工作项"}</button></article>
          <article className={stageRank[state.stage] >= 5 && state.stage !== "ACTION_SIMULATED" ? "panel demo-step complete" : state.stage === "ACTION_SIMULATED" ? "panel demo-step current" : "panel demo-step"}><span>3</span><div><h3>Action Completion</h3><p>访客确认模拟变更已完成，未修改任何外部系统。</p></div><button className="primary-button" disabled={state.stage !== "ACTION_SIMULATED"} onClick={() => advance("COMPLETE_ACTION")}>{stageRank[state.stage] >= 5 && state.stage !== "ACTION_SIMULATED" ? "已确认完成" : "确认模拟 Action 完成"}</button></article>
          <article className={state.stage === "VERIFIED" ? "panel demo-step complete" : state.stage === "ACTION_COMPLETED" ? "panel demo-step current" : "panel demo-step"}><span>4</span><div><h3>确定性 Verification</h3><p>使用静态恢复窗口验证成功率回到 95.2%。</p></div><button className="primary-button" disabled={state.stage !== "ACTION_COMPLETED"} onClick={() => advance("VERIFY")}>{state.stage === "VERIFIED" ? "验证已完成" : "运行确定性验证"}</button></article>
        </section>}
      </div>}

      {view === "evidence" && <div className="content detail-page"><section className="panel evidence-panel"><div className="evidence-header"><div><span className="section-kicker">STATIC FIXTURE ONLY</span><h2>证据库</h2></div></div>{investigated ? <DemoEvidence /> : <div className="empty-state"><strong>暂无演示证据</strong><span>运行公开演示后显示。</span></div>}</section></div>}

      {view === "audit" && <div className="content detail-page"><section className="panel audit-table"><div className="panel-heading"><div><span className="section-kicker">TAB-LOCAL DERIVED TIMELINE</span><h2>演示审计</h2></div><span className="timezone-label">仅当前标签页</span></div><div className="table-head"><span>时间</span><span>执行者</span><span>动作</span><span>来源</span></div>{auditRows.length === 0 ? <div className="empty-state"><strong>暂无演示事件</strong><span>运行流程后在本地生成。</span></div> : auditRows.map((row) => <div className="table-row" key={row.stage}><time>{new Date(row.at).toLocaleTimeString("zh-CN", { hour12: false })}</time><strong>{row.actor}</strong><span>{row.action}</span><b>DERIVED</b></div>)}</section></div>}
    </section>
  </main>;
}

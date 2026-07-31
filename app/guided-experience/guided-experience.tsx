"use client";

import Link from "next/link";
import { useState } from "react";
import { BEST_PRACTICE_SCENARIO as scenario } from "@/lib/best-practice-scenario";
import JudgmentExplanation from "@/app/judgment-explanation";

const steps = [
  "发生了什么？",
  "AI 在怀疑什么？",
  "AI 找到了什么？",
  "建议怎么办？",
  "问题解决了吗？",
] as const;

export default function GuidedExperience() {
  const [step, setStep] = useState(1);
  const [continued, setContinued] = useState(false);

  const goToStep = (nextStep: number) => {
    setStep(Math.max(1, Math.min(5, nextStep)));
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return <main className="guided-shell">
    <header className="guided-topbar">
      <Link className="guided-brand" href="/" aria-label="返回 ReleaseGuard AI">
        <span>R</span><div><strong>ReleaseGuard AI</strong><small>3 分钟引导体验</small></div>
      </Link>
      <div className="guided-demo-badge"><i />新手案例：酒店推荐策略异常 · 非生产数据</div>
      <Link className="guided-exit" href="/">退出引导</Link>
    </header>

    <section className="guided-progress" aria-label="引导进度">
      <div><span>3 分钟发布风险调查</span><b>第 {step} 步，共 5 步</b></div>
      <ol>
        {steps.map((label, index) => {
          const number = index + 1;
          return <li className={number === step ? "active" : number < step ? "complete" : ""} key={label}>
            <span>{number < step ? "✓" : number}</span><b>{label}</b>
          </li>;
        })}
      </ol>
    </section>

    <div className="guided-stage" data-testid={`guided-step-${step}`}>
      {step === 1 && <section className="guided-step guided-incident" aria-labelledby="guided-step-heading">
        <header><span>第 1 步</span><h1 id="guided-step-heading">发生了什么？</h1><p>先看业务发生了什么，再决定是否需要调查。</p></header>
        <div className="guided-incident-visual">
          <div><span>发布前</span><b>{scenario.before.conversionRate}</b><small>酒店下单转化率</small></div>
          <i aria-hidden="true">→</i>
          <div className="down"><span>发布后</span><b>{scenario.after.conversionRate}</b><small>下降 {scenario.after.absoluteDecline} · 相对下降 {scenario.after.relativeDecline}</small></div>
        </div>
        <p className="guided-key-message">新版发布{scenario.after.elapsed}后，酒店下单转化率出现明显异常。</p>
        <div className="guided-context"><span>版本 {scenario.release}</span><span>发布后{scenario.after.elapsed}</span><span>持续{scenario.after.anomalyDuration}</span></div>
        <JudgmentExplanation
          question={scenario.reasoning.risk.question}
          why={scenario.reasoning.risk.guidedWhy}
          basis={scenario.reasoning.risk.basis}
          note={`规则从哪里来？${scenario.reasoning.risk.source}`}
          className="guided-judgment"
        />
        <footer><span>团队预设风险阈值已被超过，系统建议启动调查。</span><button data-testid="guided-start" onClick={() => goToStep(2)}>开始调查 <b aria-hidden="true">→</b></button></footer>
      </section>}

      {step === 2 && <section className="guided-step" aria-labelledby="guided-step-heading">
        <header><span>第 2 步</span><h1 id="guided-step-heading">AI 在怀疑什么？</h1><p>Agent 目前发现 3 个值得调查的方向</p></header>
        <div className="guided-reasons">
          {scenario.hypotheses.map((hypothesis) => <article key={hypothesis.id}>
            <div>
              <small>{hypothesis.priority}</small>
              <h2>{hypothesis.title}</h2>
              <p>{hypothesis.summary}</p>
              <div className="guided-reason-tags">{hypothesis.signals.map((signal) => <em key={signal}>{signal}</em>)}</div>
              <details className="guided-reason-details">
                <summary>查看为什么 <span aria-hidden="true">+</span></summary>
                <p>{hypothesis.rationale}</p>
              </details>
            </div>
          </article>)}
        </div>
        <JudgmentExplanation
          question={scenario.reasoning.hypothesisSet.question}
          why={scenario.reasoning.hypothesisSet.why}
          basis={scenario.reasoning.hypothesisSet.basis}
          className="guided-judgment"
        />
        <footer><button className="guided-secondary" onClick={() => goToStep(1)}>上一步</button><button data-testid="guided-view-investigation" onClick={() => goToStep(3)}>查看 AI 如何调查 <b aria-hidden="true">→</b></button></footer>
      </section>}

      {step === 3 && <section className="guided-step" aria-labelledby="guided-step-heading">
        <header><span>第 3 步</span><h1 id="guided-step-heading">AI 找到了什么？</h1><p>Agent 同时寻找支持证据和反证，避免过早下结论。</p></header>
        {continued && <div className="guided-continued" role="status"><strong>已选择继续调查（Demo）</strong><span>当前演示案例没有新增证据；你可以重新查看现有证据并决定下一步。</span></div>}
        <div className="guided-evidence-groups">
          <section className="support"><header><span>✓</span><div><b>支持排序策略问题</b><small>越来越多证据指向新版排序策略</small></div></header>
            <ul>{scenario.evidence.filter((item) => item.tone === "support").map((item) => <li key={item.source}><span>{item.source}</span><strong>{item.summary}</strong></li>)}</ul>
          </section>
          <section className="ruleout"><header><span>−</span><div><b>排除其他方向</b><small>服务健康和流量结构不支持其他解释</small></div></header>
            <ul>{scenario.evidence.filter((item) => item.tone === "contradict").map((item) => <li key={item.source}><span>{item.source}</span><strong>{item.summary}</strong></li>)}</ul>
          </section>
        </div>
        <div className="guided-causal-chain" aria-label="排序策略问题因果链">
          {scenario.reasoning.strategy.chain.map((item, index) => <div key={item}><span>{index + 1}</span><b>{item}</b></div>)}
        </div>
        <JudgmentExplanation
          question={scenario.reasoning.strategy.question}
          why={scenario.reasoning.strategy.why}
          basis={scenario.reasoning.strategy.basis}
          tone="success"
          className="guided-judgment"
        />
        <div className="guided-exclusion-reasons">
          {scenario.reasoning.exclusions.map((exclusion) => <JudgmentExplanation
            key={exclusion.hypothesisId}
            question={exclusion.question}
            why={exclusion.why}
            basis={exclusion.basis}
            note={exclusion.conclusion}
            tone="caution"
          />)}
        </div>
        <footer><button className="guided-secondary" onClick={() => goToStep(2)}>上一步</button><button data-testid="guided-view-conclusion" onClick={() => goToStep(4)}>查看调查结论 <b aria-hidden="true">→</b></button></footer>
      </section>}

      {step === 4 && <section className="guided-step" aria-labelledby="guided-step-heading">
        <header><span>第 4 步</span><h1 id="guided-step-heading">建议怎么办？</h1><p>Agent 已结合支持证据与反证形成业务判断。</p></header>
        <div className="guided-diagnosis"><span>调查结论</span><h2>Agent 判断新版排序策略是主要原因。</h2><p>{scenario.diagnosis}</p></div>
        <div className="guided-recommendation"><div><span>处置建议</span><h2>{scenario.recommendation}</h2></div><i aria-hidden="true">0.55 → 0.35</i></div>
        <JudgmentExplanation
          question={scenario.reasoning.action.question}
          why={scenario.reasoning.action.why}
          basis={scenario.reasoning.action.basis}
          note={scenario.reasoning.action.qualifier}
          className="guided-judgment"
        />
        <div className="guided-human-control"><span>!</span><p><strong>AI 不会直接修改线上策略，需要负责人确认。</strong><small>下面的选择只改变当前演示状态，不会触发真实审批、回滚或任何线上操作。</small></p></div>
        <footer className="guided-decision-actions"><button className="guided-secondary" data-testid="guided-continue" onClick={() => { setContinued(true); goToStep(3); }}>继续调查</button><button data-testid="guided-approve" onClick={() => goToStep(5)}>批准执行 <b aria-hidden="true">→</b></button></footer>
      </section>}

      {step === 5 && <section className="guided-step guided-complete" aria-labelledby="guided-step-heading">
        <header><span>第 5 步</span><h1 id="guided-step-heading">问题解决了吗？</h1><p>完成动作并不等于问题解决，Agent 还要验证业务是否恢复。</p></header>
        <div className="guided-resolution"><span>✓</span><div><small>最终状态</small><h2>风险解除</h2><p>核心业务指标已恢复至接近发布前水平。</p></div></div>
        <div className="guided-recovery-metrics">
          <div><span>下单转化率</span><b>{scenario.verification.conversionRate}</b><small>发布前基线 {scenario.verification.baseline}</small></div>
          <div><span>高价酒店曝光</span><b>{scenario.verification.premiumExposure}</b><small>发布前 {scenario.verification.premiumExposureBaseline}</small></div>
        </div>
        <JudgmentExplanation
          question={scenario.reasoning.verification.question}
          why={scenario.reasoning.verification.why}
          basis={scenario.reasoning.verification.basis}
          note={scenario.reasoning.verification.implication}
          tone="success"
          className="guided-judgment"
        />
        <ol className="guided-summary-flow" aria-label="调查完成过程">
          {["发现异常", "调查原因", "收集证据", "给出建议", "人工决策", "验证结果"].map((item, index) => <li key={item}><span>{index + 1}</span><b>{item}</b></li>)}
        </ol>
        <div className="guided-complete-actions"><Link className="guided-secondary-link" href="/best-practice">查看完整最佳实践</Link><Link className="guided-primary-link" href="/">进入完整调查工作台示例 <span aria-hidden="true">→</span></Link></div>
      </section>}
    </div>

    <footer className="guided-boundary">本引导完全使用静态演示数据，与真实 Agent 运行环境、审批和线上操作隔离。</footer>
  </main>;
}

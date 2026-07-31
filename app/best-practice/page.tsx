/* eslint-disable @next/next/no-html-link-for-pages -- Native links avoid vinext RSC hydration failures on this static page. */
import {
  BEST_PRACTICE_SCENARIO as scenario,
  BEST_PRACTICE_SECTIONS,
} from "@/lib/best-practice-scenario";
import JudgmentExplanation from "@/app/judgment-explanation";

const resultLabels = {
  SUPPORTED: "多项证据支持",
  CONTRADICTED: "当前证据不支持",
} as const;

export default function BestPracticePage() {
  return <main className="best-practice-shell">
    <header className="best-practice-topbar">
      <a className="best-practice-brand" href="/" aria-label="返回 ReleaseGuard AI">
        <span className="brand-mark">R</span>
        <span><strong>ReleaseGuard AI</strong><small>发布风险调查与处置 Agent</small></span>
      </a>
      <div className="best-practice-topbar-actions">
        <a className="best-practice-quick-link" href="/guided-experience">想先快速体验？进入 3 分钟引导</a>
        <a className="best-practice-back" href="/">← 返回工作区</a>
      </div>
    </header>

    <div className="best-practice-layout">
      <aside className="best-practice-toc" aria-label="案例章节">
        <p>最佳实践案例</p>
        <nav>
          {BEST_PRACTICE_SECTIONS.map((section, index) =>
            <a href={`#chapter-${index + 1}`} key={section}>
              <span>{String(index + 1).padStart(2, "0")}</span>{section}
            </a>)}
        </nav>
        <div className="best-practice-demo-note">
          <strong>演示数据</strong>
          <span>本案例用于说明产品工作方式，不来自真实生产环境，也不会触发真实 Agent 或线上操作。</span>
        </div>
      </aside>

      <article className="best-practice-story">
        <section className="best-practice-hero" aria-labelledby="case-title">
          <div className="best-practice-labels"><span>最佳实践</span><b>演示案例 · 非生产数据</b></div>
          <p className="best-practice-kicker">酒店业务 · {scenario.release} 发布事故</p>
          <h1 id="case-title">{scenario.title}</h1>
          <p className="best-practice-lead">从风险发现到恢复验证，完整看懂 ReleaseGuard AI 如何帮助业务团队做出有证据、可控的发布决策。</p>
          <div className="best-practice-metrics" aria-label="事故关键指标">
            <div><span>发布前转化率</span><b>{scenario.before.conversionRate}</b><small>过去 7 日基线</small></div>
            <div className="danger"><span>发布后转化率</span><b>{scenario.after.conversionRate}</b><small>下降 {scenario.after.absoluteDecline} · 相对下降 {scenario.after.relativeDecline}</small></div>
            <div><span>异常出现</span><b>{scenario.after.elapsed}</b><small>发布后</small></div>
            <div><span>异常持续</span><b>{scenario.after.anomalyDuration}</b><small>达到风险条件</small></div>
          </div>
        </section>

        <section className="best-practice-chapter" id="chapter-1">
          <header><span>01</span><div><p>事故起点</p><h2>{BEST_PRACTICE_SECTIONS[0]}</h2></div></header>
          <div className="best-practice-copy">
            <p>酒店业务团队发布 {scenario.release}，调整了酒店搜索结果中的个性化推荐策略。发布前，{scenario.metric}为 <strong>{scenario.before.conversionRate}</strong>，个性化推荐权重为 <strong>{scenario.before.recommendationWeight}</strong>。</p>
            <p>发布后{scenario.after.elapsed}，下单转化率降至 <strong>{scenario.after.conversionRate}</strong>，下降 <strong>{scenario.after.absoluteDecline}（相对下降 {scenario.after.relativeDecline}）</strong>，并持续{scenario.after.anomalyDuration}。这不再是一次短暂波动，而是需要调查的业务风险。</p>
          </div>
        </section>

        <section className="best-practice-chapter" id="chapter-2">
          <header><span>02</span><div><p>风险触发</p><h2>{BEST_PRACTICE_SECTIONS[1]}</h2></div></header>
          <div className="best-practice-rule">
            <span>团队预先配置的风险策略</span>
            <strong>{scenario.riskRule.description}</strong>
          </div>
          <JudgmentExplanation
            question={scenario.reasoning.risk.question}
            why={scenario.reasoning.risk.why}
            basis={scenario.reasoning.risk.basis}
            note={`规则从哪里来？${scenario.reasoning.risk.source}`}
            className="best-practice-judgment"
          />
          <div className="best-practice-flow" aria-label="风险发现流程">
            {[
              "指标异常",
              "风险规则触发",
              "创建风险记录",
              "开始业务调查",
            ].map((step, index) => <div key={step}><span>{index + 1}</span><b>{step}</b></div>)}
          </div>
        </section>

        <section className="best-practice-chapter" id="chapter-3">
          <header><span>03</span><div><p>提出方向</p><h2>{BEST_PRACTICE_SECTIONS[2]}</h2></div></header>
          <p className="best-practice-intro">Agent 不会直接认定某一个方向就是根因。它先形成多个可能原因，再通过证据逐一验证和排除。</p>
          <div className="best-practice-hypotheses">
            {scenario.hypotheses.map((hypothesis) => <article key={hypothesis.id}>
              <div><span>{hypothesis.id}</span><b>可能原因 {hypothesis.id}</b></div>
              <h3>{hypothesis.title}</h3>
              <small>为什么考虑</small>
              <p>{hypothesis.rationale}</p>
              <div className="best-practice-reason-signals">{hypothesis.signals.map((signal) => <em key={signal}>{signal}</em>)}</div>
            </article>)}
          </div>
          <JudgmentExplanation
            question={scenario.reasoning.hypothesisSet.question}
            why={scenario.reasoning.hypothesisSet.why}
            basis={scenario.reasoning.hypothesisSet.basis}
            className="best-practice-judgment"
          />
        </section>

        <section className="best-practice-chapter" id="chapter-4">
          <header><span>04</span><div><p>寻找证据</p><h2>{BEST_PRACTICE_SECTIONS[3]}</h2></div></header>
          <p className="best-practice-intro">Agent 调用业务工具，对照发布变更、业务指标、用户反馈、服务健康和流量结构，既寻找支持证据，也主动寻找反证。</p>
          <div className="best-practice-evidence" role="table" aria-label="调查证据">
            <div className="best-practice-evidence-head" role="row"><span>查看什么</span><span>发现什么</span><span>对判断的影响</span></div>
            {scenario.evidence.map((evidence) => <div className="best-practice-evidence-row" role="row" key={evidence.source}>
              <b>{evidence.source}</b><span>{evidence.finding}</span><em className={evidence.tone}>{evidence.conclusion}</em>
            </div>)}
          </div>
        </section>

        <section className="best-practice-chapter" id="chapter-5">
          <header><span>05</span><div><p>形成判断</p><h2>{BEST_PRACTICE_SECTIONS[4]}</h2></div></header>
          <div className="best-practice-verdicts">
            {scenario.hypotheses.map((hypothesis) => <div className={hypothesis.result === "SUPPORTED" ? "supported" : "contradicted"} key={hypothesis.id}>
              <span>{hypothesis.id}</span><p><strong>{hypothesis.title}</strong><small>{resultLabels[hypothesis.result]}</small></p>
            </div>)}
          </div>
          <div className="best-practice-causal-chain" aria-label="排序策略问题因果链">
            {scenario.reasoning.strategy.chain.map((item, index) => <div key={item}><span>{index + 1}</span><b>{item}</b></div>)}
          </div>
          <JudgmentExplanation
            question={scenario.reasoning.strategy.question}
            why={scenario.reasoning.strategy.why}
            basis={scenario.reasoning.strategy.basis}
            tone="success"
            className="best-practice-judgment"
          />
          <div className="best-practice-exclusions">
            {scenario.reasoning.exclusions.map((exclusion) => <JudgmentExplanation
              key={exclusion.hypothesisId}
              question={exclusion.question}
              why={exclusion.why}
              basis={exclusion.basis}
              note={exclusion.conclusion}
              tone="caution"
            />)}
          </div>
          <blockquote><span>最终诊断</span><p>{scenario.diagnosis}</p></blockquote>
        </section>

        <section className="best-practice-chapter" id="chapter-6">
          <header><span>06</span><div><p>安全处置</p><h2>{BEST_PRACTICE_SECTIONS[5]}</h2></div></header>
          <div className="best-practice-approval">
            <div><span>Agent 处置建议</span><h3>{scenario.recommendation}</h3></div>
            <div className="best-practice-approval-state"><span>当前状态</span><b>等待人工审批</b></div>
          </div>
          <JudgmentExplanation
            question={scenario.reasoning.action.question}
            why={scenario.reasoning.action.why}
            basis={scenario.reasoning.action.basis}
            note={scenario.reasoning.action.qualifier}
            className="best-practice-judgment"
          />
          <p className="best-practice-emphasis">Agent 负责调查、证据整理和提出建议；业务负责人决定是否执行影响线上业务的操作。建议不会被 Agent 自动直接执行。</p>
        </section>

        <section className="best-practice-chapter" id="chapter-7">
          <header><span>07</span><div><p>恢复确认</p><h2>{BEST_PRACTICE_SECTIONS[6]}</h2></div></header>
          <p className="best-practice-intro">人工批准并完成回滚后，Agent 继续检查核心业务指标是否恢复，而不是把“动作已执行”误当成“问题已解决”。</p>
          <div className="best-practice-verification">
            <div><span>下单转化率</span><b>{scenario.verification.conversionRate}</b><small>发布前基线 {scenario.verification.baseline}</small></div>
            <div><span>高价酒店 Top 10 曝光占比</span><b>{scenario.verification.premiumExposure}</b><small>发布前 {scenario.verification.premiumExposureBaseline}</small></div>
            <div className="pass"><span>验证结论</span><b>通过</b><small>核心业务指标恢复</small></div>
          </div>
          <JudgmentExplanation
            question={scenario.reasoning.verification.question}
            why={scenario.reasoning.verification.why}
            basis={scenario.reasoning.verification.basis}
            note={scenario.reasoning.verification.implication}
            tone="success"
            className="best-practice-judgment"
          />
          <div className="best-practice-result"><span>✓</span><strong>{scenario.verification.result}</strong></div>
        </section>

        <section className="best-practice-chapter best-practice-summary" id="chapter-8">
          <header><span>08</span><div><p>业务价值</p><h2>{BEST_PRACTICE_SECTIONS[7]}</h2></div></header>
          <p>{scenario.summary}</p>
          <div className="best-practice-capabilities" aria-label="ReleaseGuard AI 完成的工作">
            {["自动发现风险", "验证多个原因", "整理业务证据", "排除错误方向", "提出处置建议", "审批后验证恢复"].map((item) => <span key={item}>{item}</span>)}
          </div>
        </section>

        <footer className="best-practice-footer">
          <span>本页为产品最佳实践演示，全部数据均为明确标识的静态案例数据。</span>
          <a href="/">返回 ReleaseGuard AI 工作区 →</a>
        </footer>
      </article>
    </div>
  </main>;
}

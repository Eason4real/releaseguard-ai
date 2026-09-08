import Link from "next/link";

const publicMetrics = [
  { label: "固定 DEV benchmark", value: "22 cases", detail: "合成、可复现，单轮运行" },
  { label: "关键证据触达", value: "22 / 22", detail: "每案至少收集一项 Gold key evidence" },
  { label: "完整证据覆盖", value: "14 / 22", detail: "收集完整 Gold key-evidence set" },
  { label: "受控工具调用", value: "40", detail: "全部为只读 investigation tool calls" },
];

const evaluationFlow = ["Fixed Gold Dataset", "Agent Run", "Evidence Scoring", "Blind Judge", "Failure Taxonomy", "Iteration"];

const findings = [
  {
    title: "Evidence Collection 已形成",
    body: "Final V8 在全部案例中触达至少一项关键证据，说明受控工具取证链路能够工作。",
  },
  {
    title: "Citation projection 仍需加强",
    body: "已收集证据没有稳定进入最终引用，Evidence 到用户可核验结论之间仍有断层。",
  },
  {
    title: "Limitation contract 暴露边界",
    body: "部分运行在 contract 边界终止。项目保留这些失败，用于定位 runtime 与表达层问题。",
  },
  {
    title: "Grounded synthesis 是下一阶段课题",
    body: "当前评测支持继续研究证据投影和综合表达，不支持把结果解释为生产环境准确率。",
  },
];

export default function BenchmarkPage() {
  return <main className="benchmark-page">
    <header className="benchmark-hero">
      <nav><Link href="/">← 返回 ReleaseGuard AI</Link><a href="https://github.com/Eason4real/releaseguard-ai" target="_blank" rel="noreferrer">GitHub ↗</a></nav>
      <div className="benchmark-hero-grid">
        <div>
          <span className="benchmark-kicker">PORTFOLIO V1.0 · FINAL V8 EVALUATION</span>
          <h1>用固定案例检查 Agent 是否真的收集证据</h1>
          <p>这是一套合成、可复现的 DEV benchmark，用于验证调查流程、证据覆盖与失败边界，不代表生产环境准确率。</p>
          <div className="benchmark-badges"><b>Harness V8</b><span>gpt-5.6-sol</span><span>single-run</span></div>
        </div>
        <aside>
          <span>评测范围</span>
          <strong>22</strong>
          <b>fixed DEV cases</b>
          <small>Gold 仅用于运行后的 scorer 与 judge，不进入 Agent runtime</small>
        </aside>
      </div>
    </header>

    <section className="benchmark-section benchmark-overview">
      <div className="benchmark-section-heading"><span>01 / 结果概览</span><div><h2>公开展示聚焦调查与证据覆盖</h2><p>低层 judge 分数与诊断得分不作为招聘或产品 KPI 展示。</p></div></div>
      <div className="benchmark-result-grid">{publicMetrics.map((metric, index) => <article className={`benchmark-result-card tone-${index}`} key={metric.label}>
        <header><span>指标 {String(index + 1).padStart(2, "0")}</span><h2>{metric.label}</h2></header>
        <div className="benchmark-primary-metric"><strong>{metric.value}</strong><small>{metric.detail}</small></div>
      </article>)}</div>
    </section>

    <section className="benchmark-section">
      <div className="benchmark-section-heading"><span>02 / 方法</span><div><h2>从固定 Gold 到 Failure Taxonomy</h2><p>评测不仅判断结果，也保留取证过程和失败原因。</p></div></div>
      <div className="benchmark-error-list">{evaluationFlow.map((step, index) => <article key={step}>
        <header><b>{String(index + 1).padStart(2, "0")}</b><span>{step}</span></header>
      </article>)}</div>
    </section>

    <section className="benchmark-section benchmark-split">
      <div>
        <div className="benchmark-section-heading compact"><span>03 / 发现</span><div><h2>Final V8 暴露的系统边界</h2><p>完整分数保留在内部实验 artifacts，公开页面呈现可解释的结论。</p></div></div>
        <div className="benchmark-error-list">{findings.map((finding) => <article key={finding.title}>
          <header><b>{finding.title}</b></header><p>{finding.body}</p>
        </article>)}</div>
      </div>
      <div>
        <div className="benchmark-section-heading compact"><span>04 / 限制</span><div><h2>如何理解这些结果</h2><p>评测可信度依赖边界说明，而不是单一数字。</p></div></div>
        <ul className="benchmark-limitations">
          <li>Final V8 只运行一轮，未做 multi-seed 或 3×22。</li>
          <li>数据来自合成、可复现 fixture，不是真实企业生产流量。</li>
          <li>LLM query selection 与 Blind Judge 都可能存在采样方差。</li>
          <li>Evidence collection 强于 citation 与 grounded synthesis。</li>
        </ul>
      </div>
    </section>

    <footer className="benchmark-footer">
      <div><span>继续深入</span><h2>查看评测方法与失败分析</h2><p>公开文档解释 metric 定义、评分边界和当前系统限制，不直接展示低层 Final KPI。</p></div>
      <nav><a href="https://github.com/Eason4real/releaseguard-ai/blob/main/docs/evaluation/methodology.md" target="_blank" rel="noreferrer">评分方法</a><a href="https://github.com/Eason4real/releaseguard-ai/blob/main/docs/investigation-benchmark-evaluation-contract.md" target="_blank" rel="noreferrer">Benchmark Contract</a><a href="https://github.com/Eason4real/releaseguard-ai/blob/main/docs/evaluation/portfolio-v1-failure-analysis.md" target="_blank" rel="noreferrer">Failure Analysis</a></nav>
    </footer>
  </main>;
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Rate = { successes: number; total: number; proportion: number | null; lower: number | null; upper: number | null };
type SystemResult = {
  system: string;
  technicalCompletion: Rate;
  businessCompletion: Rate;
  rootCause: { score2Strict: Rate; score1Or2Lenient: Rate; meanScore: number | null; notApplicable: number };
  performance: { durationMsP50: number; durationMsP95: number; peakCost: { estimatedUsd: number }; toolCallsMean: number; modelCallsMean: number };
  terminalStates: Record<string, number>;
  errors: Record<string, number>;
  evidence: { meanCriticalEvidenceRecall: number | null; citationValidity: Rate };
};
type Summary = {
  evaluationVersion: string;
  generatedAt: string;
  latestEvaluationCompletedAt: string;
  sourceCommit: string;
  dataset: {
    cases: number;
    runsPerSystem: number;
    trialsPerSystem: number;
    hash: string;
    sourceClassDistribution: Record<string, number>;
    incidentTypeDistribution: Record<string, number>;
    claimBoundary: string;
  };
  model: { provider: string; model: string; temperature: number };
  systems: SystemResult[];
  slices: { category: Record<string, Record<string, { trials: number; technical: Rate; score2: Rate; meanScore: number | null }>> };
  judge: { type: string; reviewQueueRows: number };
  typicalTrace: null | {
    system?: string;
    caseId: string;
    runIndex: number;
    diagnosis: string;
    rootCauseScore: string;
    actions: Array<{ sequence: number; decisionType: string; rationale: string }>;
    tools: Array<{ toolName: string; resultStatus: string; evidenceIds: string[] }>;
  };
  artifacts: { methodology: string; reproduce: string; report: string; reviewQueue: string; rawDirectory: string; github: string };
  limitations: string[];
};

const labels: Record<string, string> = {
  DIRECT_LLM: "Direct LLM",
  CURRENT_AGENT: "Current Agent",
  IMPROVED_AGENT: "Improved Agent",
  HARNESS_V2: "Harness v2",
  HARNESS_V3: "Harness v3",
  HARNESS_V7: "Harness v7",
};
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const rateText = (rate: Rate) => `${rate.successes}/${rate.total} · ${percent(rate.proportion)}`;
const intervalText = (rate: Rate) => rate.lower === null ? "无可用区间" : `Wilson 95% CI ${percent(rate.lower)}–${percent(rate.upper)}`;
const seconds = (value: number) => `${(value / 1000).toFixed(1)}s`;

function ComparisonBar({ rate, tone }: { rate: Rate; tone: string }) {
  return <div className="benchmark-bar" aria-label={rateText(rate)}>
    <i className={tone} style={{ width: `${(rate.proportion ?? 0) * 100}%` }} />
  </div>;
}

function ResultCard({ result, index }: { result: SystemResult; index: number }) {
  return <article className={`benchmark-result-card tone-${index}`}>
    <header><span>方案 {String.fromCharCode(65 + index)}</span><h2>{labels[result.system] ?? result.system}</h2></header>
    <div className="benchmark-primary-metric">
      <span>严格根因准确率</span>
      <strong>{rateText(result.rootCause.score2Strict)}</strong>
      <small>{intervalText(result.rootCause.score2Strict)}</small>
      <ComparisonBar rate={result.rootCause.score2Strict} tone={`tone-${index}`} />
    </div>
    <dl>
      <div><dt>技术完成</dt><dd>{rateText(result.technicalCompletion)}</dd></div>
      <div><dt>业务完成</dt><dd>{rateText(result.businessCompletion)}</dd></div>
      <div><dt>宽松命中</dt><dd>{rateText(result.rootCause.score1Or2Lenient)}</dd></div>
      <div><dt>平均得分</dt><dd>{result.rootCause.meanScore?.toFixed(2) ?? "—"} / 2</dd></div>
      <div><dt>P50 / P95</dt><dd>{seconds(result.performance.durationMsP50)} / {seconds(result.performance.durationMsP95)}</dd></div>
      <div><dt>峰时估算费用</dt><dd>${result.performance.peakCost.estimatedUsd.toFixed(3)} / 66 次</dd></div>
    </dl>
  </article>;
}

export default function BenchmarkPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    void fetch("/evaluation/summary-v7.json", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("SUMMARY_UNAVAILABLE");
        return response.json() as Promise<Summary>;
      })
      .then(setSummary)
      .catch(() => setError(true));
  }, []);

  if (!summary) return <main className="benchmark-loading">
    <div><b>{error ? "评测摘要暂不可用" : "正在载入可审计评测结果…"}</b><p>{error ? "请先运行 npm run eval:summary 生成构建数据。" : "页面只读取生成的 summary.json，不维护手写指标。"}</p><Link href="/">返回公开演示</Link></div>
  </main>;

  const sourceClasses = Object.entries(summary.dataset.sourceClassDistribution);
  const categories = Object.entries(summary.slices.category);
  return <main className="benchmark-page">
    <header className="benchmark-hero">
      <nav><Link href="/">← 返回 ReleaseGuard AI</Link><a href={summary.artifacts.github} target="_blank" rel="noreferrer">GitHub 原始结果 ↗</a></nav>
      <div className="benchmark-hero-grid">
        <div>
          <span className="benchmark-kicker">RELEASEGUARD EVALUATION · {summary.evaluationVersion}</span>
          <h1>{summary.dataset.cases} 个离线案例，{summary.systems.length} 种方案，<br />每案独立运行三次</h1>
          <p>这是一套可复现的 Dev 评测，不是真实企业生产数据。数据实际由 16 个合成案例和 6 个仓库原生案例构成；不能称为“22 个独立公开事故复盘”。</p>
          <div className="benchmark-badges"><b>同模型对照</b><span>{summary.model.model} · temperature {summary.model.temperature}</span><span>{summary.dataset.trialsPerSystem} 次/方案</span></div>
        </div>
        <aside>
          <span>评测边界</span>
          <strong>{summary.dataset.cases}</strong>
          <b>governed offline cases</b>
          <small>{sourceClasses.map(([name, count]) => `${count} ${name.replaceAll("_", " ")}`).join(" · ")}</small>
          <code title={summary.dataset.hash}>{summary.dataset.hash.slice(0, 16)}…</code>
        </aside>
      </div>
    </header>

    <section className="benchmark-section benchmark-overview">
      <div className="benchmark-section-heading"><span>01 / 总览</span><div><h2>对照结果</h2><p>根因分数来自隐藏方案名、固定乱序的同模型盲评，因此属于非独立 LLM 评审，不是人工审核。</p></div></div>
      <div className="benchmark-result-grid">{summary.systems.map((result, index) => <ResultCard key={result.system} result={result} index={index} />)}</div>
    </section>

    <section className="benchmark-section">
      <div className="benchmark-section-heading"><span>02 / 分层</span><div><h2>按事故类型拆分</h2><p>每个格子同时保留原始数量；小样本切片只用于定位失败，不作泛化结论。</p></div></div>
      <div className="benchmark-table-wrap"><table className="benchmark-table">
        <thead><tr><th>事故类型</th>{summary.systems.map((system) => <th key={system.system}>{labels[system.system]}<small>严格 2 分 / 技术完成</small></th>)}</tr></thead>
        <tbody>{categories.map(([category, values]) => <tr key={category}>
          <td><b>{category.replaceAll("_", " ")}</b><span>{summary.dataset.incidentTypeDistribution[category]} 案例 × 3</span></td>
          {summary.systems.map((system) => <td key={system.system}><strong>{rateText(values[system.system].score2)}</strong><small>{rateText(values[system.system].technical)}</small></td>)}
        </tr>)}</tbody>
      </table></div>
    </section>

    <section className="benchmark-section benchmark-split">
      <div>
        <div className="benchmark-section-heading compact"><span>03 / 错误</span><div><h2>技术错误分布</h2><p>保留所有失败运行，不用重跑覆盖。</p></div></div>
        <div className="benchmark-error-list">{summary.systems.map((system) => <article key={system.system}>
          <header><b>{labels[system.system]}</b><span>{Object.values(system.errors).reduce((total, value) => total + value, 0)} 次技术失败</span></header>
          {Object.keys(system.errors).length === 0 ? <p>未记录技术错误</p> : Object.entries(system.errors).map(([name, count]) => <div key={name}><code>{name}</code><strong>{count}</strong></div>)}
        </article>)}</div>
      </div>
      <div>
        <div className="benchmark-section-heading compact"><span>04 / 边界</span><div><h2>可信度说明</h2><p>评测可信度优先于数字是否好看。</p></div></div>
        <ul className="benchmark-limitations">{summary.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
        <div className="benchmark-review-note"><b>{summary.judge.reviewQueueRows}</b><span>条输出进入人工复核清单；在真正复核前不称为“人工审核准确率”。</span></div>
      </div>
    </section>

    {summary.typicalTrace && <section className="benchmark-section">
      <div className="benchmark-section-heading"><span>05 / 轨迹</span><div><h2>典型调查轨迹 · {summary.typicalTrace.caseId}</h2><p>{labels[summary.typicalTrace.system ?? "IMPROVED_AGENT"]} 第 {summary.typicalTrace.runIndex} 轮，盲评根因得分 {summary.typicalTrace.rootCauseScore}/2。</p></div></div>
      <div className="benchmark-trace">
        <div>{summary.typicalTrace.actions.map((action) => <article key={action.sequence}><span>{String(action.sequence).padStart(2, "0")}</span><div><b>{action.decisionType}</b><p>{action.rationale}</p></div></article>)}</div>
        <aside><span>最终诊断</span><p>{summary.typicalTrace.diagnosis}</p><h3>工具与证据</h3>{summary.typicalTrace.tools.map((tool, index) => <div key={`${tool.toolName}-${index}`}><code>{tool.toolName}</code><b>{tool.resultStatus}</b><small>{tool.evidenceIds.join(", ") || "无新增证据"}</small></div>)}</aside>
      </div>
    </section>}

    <footer className="benchmark-footer">
      <div><span>复现与审计</span><h2>数字来自生成物，不来自页面手填</h2><p>摘要生成时间 {new Date(summary.generatedAt).toLocaleString("zh-CN")} · 源 Commit {summary.sourceCommit.slice(0, 12)} · 最近完成 {new Date(summary.latestEvaluationCompletedAt).toLocaleString("zh-CN")}</p></div>
      <nav><a href="https://github.com/Eason4real/releaseguard-ai/blob/main/docs/evaluation/releaseguard-evaluation-report.md" target="_blank" rel="noreferrer">正式报告</a><a href="https://github.com/Eason4real/releaseguard-ai/blob/main/docs/evaluation/methodology.md" target="_blank" rel="noreferrer">评分方法</a><a href="https://github.com/Eason4real/releaseguard-ai/blob/main/docs/evaluation/reproduce.md" target="_blank" rel="noreferrer">复现步骤</a><a href="https://github.com/Eason4real/releaseguard-ai/tree/main/evaluation/results/raw" target="_blank" rel="noreferrer">原始结果</a></nav>
    </footer>
  </main>;
}

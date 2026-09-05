import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const summary = JSON.parse(await readFile(new URL("evaluation/results/summary.json", root), "utf8"));
const reportUrl = new URL("docs/evaluation/releaseguard-evaluation-report.md", root);
let report = await readFile(reportUrl, "utf8");
const labels = { DIRECT_LLM: "Direct LLM", CURRENT_AGENT: "Current Agent", IMPROVED_AGENT: "Improved Agent" };
const pct = (value) => value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const rate = (item) => `${item.successes}/${item.total} (${pct(item.proportion)}; Wilson 95% CI ${pct(item.lower)}–${pct(item.upper)})`;
const seconds = (value) => `${(value / 1000).toFixed(1)} s`;
const replace = (name, content) => {
  const start = `<!-- GENERATED_${name}_START -->`;
  const end = `<!-- GENERATED_${name}_END -->`;
  const expression = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!expression.test(report)) throw new Error(`REPORT_MARKER_MISSING:${name}`);
  report = report.replace(expression, `${start}\n${content.trim()}\n${end}`);
};

replace("OVERALL", [
  "| System | Technical completion | Business completion | Strict score 2 | Lenient score 1–2 | Mean score | N/A |",
  "| --- | --- | --- | --- | --- | ---: | ---: |",
  ...summary.systems.map((item) => `| ${labels[item.system]} | ${rate(item.technicalCompletion)} | ${rate(item.businessCompletion)} | ${rate(item.rootCause.score2Strict)} | ${rate(item.rootCause.score1Or2Lenient)} | ${item.rootCause.meanScore ?? "—"} / 2 | ${item.rootCause.notApplicable} |`),
  "",
  `Judge: ${summary.judge.type}; status ${summary.judge.status}; ${summary.judge.failedCases}/${summary.judge.cases} case-level judge requests failed and ${summary.judge.scoredOutputs} trial outputs received scores. ${summary.judge.reviewQueueRows} trial outputs are listed for human review. These are not human-reviewed scores.${summary.judge.failureReason ? ` Failure reason: ${summary.judge.failureReason}.` : ""}`,
].join("\n"));

const sliceTables = [];
for (const [dimension, values] of Object.entries(summary.slices)) {
  sliceTables.push(`### ${dimension === "category" ? "Incident type" : "Difficulty"}`);
  sliceTables.push("| Slice | System | Trials | Strict score 2 | Technical completion | Mean score |", "| --- | --- | ---: | --- | --- | ---: |");
  for (const [slice, systems] of Object.entries(values)) {
    for (const [system, item] of Object.entries(systems)) {
      sliceTables.push(`| ${slice} | ${labels[system]} | ${item.trials} | ${rate(item.score2)} | ${rate(item.technical)} | ${item.meanScore ?? "—"} |`);
    }
  }
  sliceTables.push("");
}
replace("SLICES", sliceTables.join("\n"));

replace("PERFORMANCE", [
  "| System | Pass@1 technical | All 3 technical | Terminal consistency | Root-score consistency | P50 | P95 | Model calls | Tool calls | Peak cost estimate |",
  "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |",
  ...summary.systems.map((item) => `| ${labels[item.system]} | ${rate(item.stability.passAt1Technical)} | ${rate(item.stability.allThreeTechnical)} | ${rate(item.stability.terminalStateConsistency)} | ${rate(item.stability.rootScoreConsistency)} | ${seconds(item.performance.durationMsP50)} | ${seconds(item.performance.durationMsP95)} | ${item.performance.modelCallsTotal} | ${item.performance.toolCallsTotal} | $${item.performance.peakCost.estimatedUsd.toFixed(4)} |`),
  "",
  ...summary.systems.map((item) => `- **${labels[item.system]} errors:** ${Object.keys(item.errors).length ? Object.entries(item.errors).map(([name, count]) => `\`${name}\` ${count}`).join(", ") : "none recorded"}. Tokens: ${item.performance.peakCost.inputTokens.toLocaleString()} input / ${item.performance.peakCost.outputTokens.toLocaleString()} output.`),
].join("\n"));

const current = summary.systems.find((item) => item.system === "CURRENT_AGENT");
const improved = summary.systems.find((item) => item.system === "IMPROVED_AGENT");
const deltaPoints = (after, before) => after === null || before === null ? "—" : `${((after - before) * 100).toFixed(1)} percentage points`;
const numberDelta = (after, before, digits = 2, suffix = "") => after === null || before === null
  ? "—"
  : `${(after - before).toFixed(digits)}${suffix}`;
replace("DELTA", [
  "| Metric | Current Agent | Improved Agent | Delta |",
  "| --- | ---: | ---: | ---: |",
  `| Technical completion | ${rate(current.technicalCompletion)} | ${rate(improved.technicalCompletion)} | ${deltaPoints(improved.technicalCompletion.proportion, current.technicalCompletion.proportion)} |`,
  `| Business completion | ${rate(current.businessCompletion)} | ${rate(improved.businessCompletion)} | ${deltaPoints(improved.businessCompletion.proportion, current.businessCompletion.proportion)} |`,
  `| Strict root-cause accuracy | ${rate(current.rootCause.score2Strict)} | ${rate(improved.rootCause.score2Strict)} | ${deltaPoints(improved.rootCause.score2Strict.proportion, current.rootCause.score2Strict.proportion)} |`,
  `| Mean root-cause score | ${current.rootCause.meanScore ?? "—"} | ${improved.rootCause.meanScore ?? "—"} | ${numberDelta(improved.rootCause.meanScore, current.rootCause.meanScore)} |`,
  `| P50 latency | ${seconds(current.performance.durationMsP50)} | ${seconds(improved.performance.durationMsP50)} | ${numberDelta(improved.performance.durationMsP50 / 1000, current.performance.durationMsP50 / 1000, 1, " s")} |`,
  `| P95 latency | ${seconds(current.performance.durationMsP95)} | ${seconds(improved.performance.durationMsP95)} | ${numberDelta(improved.performance.durationMsP95 / 1000, current.performance.durationMsP95 / 1000, 1, " s")} |`,
  `| Peak estimated cost | $${current.performance.peakCost.estimatedUsd.toFixed(4)} | $${improved.performance.peakCost.estimatedUsd.toFixed(4)} | $${numberDelta(improved.performance.peakCost.estimatedUsd, current.performance.peakCost.estimatedUsd, 4)} |`,
].join("\n"));

await writeFile(reportUrl, report);
console.log(JSON.stringify({ report: reportUrl.pathname, generatedAt: summary.generatedAt }, null, 2));

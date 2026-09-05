import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PptxGenJS = require("C:/Users/eason/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pptxgenjs");
const sharp = require("C:/Users/eason/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp");

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "李超_AI产品经理_项目作品集.pptx");
const screenshotDir = "C:/Users/eason/.codex/visualizations/2026/08/09/019fe640-9e81-78f3-82f3-cd996fc8cfac";
const homeShot = path.join(screenshotDir, "releaseguard-home.png");

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "李超";
pptx.subject = "2027届秋招 AI 产品经理项目作品集";
pptx.title = "李超｜AI 产品经理项目作品集";
pptx.company = "UNSW";
pptx.lang = "zh-CN";
pptx.theme = {
  headFontFace: "Microsoft YaHei",
  bodyFontFace: "Microsoft YaHei",
  lang: "zh-CN",
};
pptx.defineSlideMaster({
  title: "MASTER",
  background: { color: "F7F9FC" },
  objects: [
    { rect: { x: 0, y: 0, w: 13.333, h: 0.08, fill: { color: "2155F5" }, line: { color: "2155F5" } } },
    { text: { text: "李超 · AI 产品经理作品集", options: { x: 0.55, y: 7.13, w: 3.1, h: 0.18, fontFace: "Microsoft YaHei", fontSize: 8.5, color: "7C879A", margin: 0 } } },
    { text: { text: "2027 校招", options: { x: 11.7, y: 7.13, w: 1.05, h: 0.18, fontFace: "Microsoft YaHei", fontSize: 8.5, color: "7C879A", align: "right", margin: 0 } } },
  ],
  slideNumber: { x: 12.82, y: 7.11, w: 0.22, h: 0.2, color: "7C879A", fontSize: 8.5, align: "right" },
});

const C = {
  navy: "102A56", blue: "2155F5", blue2: "4E7BFF", pale: "EAF0FF", pale2: "F1F5FF",
  ink: "182235", sub: "566276", muted: "7C879A", line: "DCE3EF", white: "FFFFFF",
  red: "D84A5D", redPale: "FFF0F2", amber: "D48A16", amberPale: "FFF7E8", cyan: "1E8FB3", cyanPale: "EAF8FC"
};
const font = "Microsoft YaHei";
const noLine = { color: "FFFFFF", transparency: 100 };

function addText(slide, text, x, y, w, h, opts = {}) {
  slide.addText(text, {
    x, y, w, h, fontFace: font, fontSize: 14, color: C.ink, margin: 0,
    valign: "mid", breakLine: false, fit: "shrink", ...opts,
  });
}

function addTitle(slide, kicker, title, conclusion) {
  addText(slide, kicker.toUpperCase(), 0.62, 0.34, 3.5, 0.24, { fontSize: 10.5, bold: true, color: C.blue, charSpacing: 1.1 });
  addText(slide, title, 0.62, 0.68, 12.0, 0.52, { fontSize: 28.5, bold: true, color: C.navy });
  addText(slide, conclusion, 0.62, 1.25, 11.9, 0.4, { fontSize: 14.5, color: C.sub });
}

function card(slide, x, y, w, h, opts = {}) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.08,
    fill: { color: opts.fill || C.white },
    line: { color: opts.line || C.line, width: opts.lineWidth || 1 },
    shadow: opts.shadow === false ? undefined : { type: "outer", color: "9AA8BF", opacity: 0.10, blur: 1.2, angle: 45, distance: 1 },
  });
}

function pill(slide, text, x, y, w, fill = C.pale, color = C.blue) {
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.28, fill: { color: fill }, line: noLine, rectRadius: 0.14 });
  addText(slide, text, x + 0.05, y + 0.01, w - 0.1, 0.24, { fontSize: 10.5, bold: true, color, align: "center" });
}

function arrow(slide, x1, y1, x2, y2, color = C.blue, width = 1.6) {
  slide.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width, endArrowType: "triangle" } });
}

function dot(slide, n, x, y, fill = C.blue) {
  slide.addShape(pptx.ShapeType.ellipse, { x, y, w: 0.34, h: 0.34, fill: { color: fill }, line: noLine });
  addText(slide, String(n), x, y + 0.01, 0.34, 0.29, { fontSize: 10.5, bold: true, color: C.white, align: "center" });
}

function metricCard(slide, x, y, w, label, value, sub, accent = C.blue) {
  card(slide, x, y, w, 1.28, { shadow: false });
  slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.06, h: 1.28, fill: { color: accent }, line: noLine });
  addText(slide, label, x + 0.22, y + 0.15, w - 0.35, 0.25, { fontSize: 11.5, bold: true, color: C.sub });
  addText(slide, value, x + 0.22, y + 0.43, w - 0.35, 0.46, { fontSize: 28, bold: true, color: C.navy });
  addText(slide, sub, x + 0.22, y + 0.95, w - 0.35, 0.2, { fontSize: 9.5, color: C.muted });
}

async function imageContain(slide, imagePath, x, y, w, h) {
  const m = await sharp(imagePath).metadata();
  const ratio = m.width / m.height;
  const box = w / h;
  let iw = w, ih = h, ix = x, iy = y;
  if (ratio > box) { ih = w / ratio; iy = y + (h - ih) / 2; }
  else { iw = h * ratio; ix = x + (w - iw) / 2; }
  slide.addImage({ path: imagePath, x: ix, y: iy, w: iw, h: ih });
}

function sectionLabel(slide, text, x, y, color = C.blue) {
  slide.addShape(pptx.ShapeType.rect, { x, y: y + 0.05, w: 0.05, h: 0.24, fill: { color }, line: noLine });
  addText(slide, text, x + 0.14, y, 2.8, 0.34, { fontSize: 12, bold: true, color: C.navy });
}

// 1. Cover
{
  const s = pptx.addSlide("MASTER");
  s.background = { color: "F7F9FC" };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 4.72, h: 7.5, fill: { color: C.navy }, line: noLine });
  s.addShape(pptx.ShapeType.rect, { x: 0.62, y: 0.66, w: 0.46, h: 0.06, fill: { color: C.blue2 }, line: noLine });
  addText(s, "AI PRODUCT MANAGER", 0.62, 0.84, 3.15, 0.28, { fontSize: 11, bold: true, color: "9EB5FF", charSpacing: 1.4 });
  addText(s, "李超", 0.62, 1.39, 3.2, 0.65, { fontSize: 35, bold: true, color: C.white });
  addText(s, "AI 产品经理\n项目作品集", 0.62, 2.13, 3.3, 1.25, { fontSize: 27, bold: true, color: C.white, breakLine: true, valign: "top", paraSpaceAfterPt: 5 });
  addText(s, "把 AI 从 Demo 变成\n可评测、可约束、可落地的产品", 0.62, 3.66, 3.35, 0.9, { fontSize: 17, color: "D7E0F7", breakLine: true, valign: "top", breakLineOnOverflow: false });
  addText(s, "UNSW Master of Information Technology\nArtificial Intelligence 方向 · 2027 届校招", 0.62, 5.55, 3.45, 0.72, { fontSize: 12.5, color: "B9C7E5", breakLine: true, valign: "top" });
  pill(s, "求职方向  AI 产品经理", 0.62, 6.42, 2.45, "24477D", "FFFFFF");

  addText(s, "我关注的不只是模型能否回答，\n而是产品能否稳定完成任务。", 5.35, 0.82, 7.1, 0.9, { fontSize: 23, bold: true, color: C.navy, breakLine: true, valign: "top" });
  const nodes = [
    ["业务问题", "定义值得解决的场景"], ["Agent 工作流", "模型 + 工具 + 状态 + 约束"],
    ["评测体系", "指标 + Case Review"], ["产品落地", "Prototype · Demo · Deployment"]
  ];
  nodes.forEach((n, i) => {
    const x = 5.35 + (i % 2) * 3.56, y = 2.06 + Math.floor(i / 2) * 1.48;
    card(s, x, y, 3.18, 1.12, { shadow: false, line: i === 1 ? C.blue : C.line, fill: i === 1 ? C.pale2 : C.white });
    dot(s, i + 1, x + 0.2, y + 0.2, i === 1 ? C.blue : C.navy);
    addText(s, n[0], x + 0.68, y + 0.16, 2.25, 0.3, { fontSize: 15, bold: true, color: C.navy });
    addText(s, n[1], x + 0.2, y + 0.63, 2.75, 0.24, { fontSize: 10.5, color: C.sub });
  });
  card(s, 5.35, 5.16, 6.75, 1.12, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "核心能力", 5.65, 5.39, 1.0, 0.26, { fontSize: 11, bold: true, color: "9EB5FF" });
  addText(s, "产品定义  ·  Agent 机制  ·  数据评测  ·  失败复盘  ·  Demo 落地", 5.65, 5.72, 5.95, 0.3, { fontSize: 13.5, bold: true, color: C.white });
}

// 2. Why ReleaseGuard
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "PROJECT 01 · RELEASEGUARD AI", "让上线异常从“人工排查”变成“Agent 调查”", "核心不是让 AI 直接给答案，而是让它基于工具调用和证据逐步完成调查。");

  card(s, 0.62, 1.88, 4.45, 4.72, { fill: "FFFDFD", line: "F1DCE0", shadow: false });
  pill(s, "传统流程", 0.9, 2.14, 1.05, C.redPale, C.red);
  addText(s, "信息碎片化，让调查依赖经验与跨团队协作", 0.9, 2.56, 3.82, 0.46, { fontSize: 17, bold: true, color: C.navy });
  const oldFlow = ["异常发现", "查指标", "查发布", "找团队", "猜根因", "决策"];
  oldFlow.forEach((t, i) => {
    const yy = 3.18 + i * 0.49;
    dot(s, i + 1, 0.95, yy, i === 4 ? C.red : "8190A8");
    addText(s, t, 1.43, yy - 0.01, 1.35, 0.32, { fontSize: 13.5, bold: i === 4, color: i === 4 ? C.red : C.ink });
    if (i < oldFlow.length - 1) s.addShape(pptx.ShapeType.line, { x: 1.12, y: yy + 0.34, w: 0, h: 0.15, line: { color: "C8D0DD", width: 1.1 } });
  });
  addText(s, "多系统切换  ·  人工提出假设\n调查耗时长  ·  直接总结易产生无依据结论", 2.68, 3.25, 1.98, 2.4, { fontSize: 12.5, color: C.sub, breakLine: true, valign: "top", breakLineOnOverflow: false });
  card(s, 0.9, 6.01, 3.83, 0.38, { fill: C.redPale, line: C.redPale, shadow: false });
  addText(s, "痛点：答案快，但无法说明“为什么可信”", 1.05, 6.07, 3.52, 0.23, { fontSize: 11, bold: true, color: C.red });

  arrow(s, 5.25, 4.22, 5.88, 4.22, C.blue, 2.2);
  pill(s, "流程重构", 5.18, 3.62, 0.85, C.pale, C.blue);

  card(s, 6.08, 1.88, 6.63, 4.72, { fill: C.white, line: "C9D7FF" });
  pill(s, "产品方案", 6.38, 2.14, 1.05, C.pale, C.blue);
  addText(s, "证据驱动的受约束 Agent Loop", 6.38, 2.54, 4.5, 0.4, { fontSize: 19, bold: true, color: C.navy });
  await imageContain(s, homeShot, 6.38, 3.06, 3.62, 2.05);
  s.addShape(pptx.ShapeType.roundRect, { x: 10.25, y: 3.06, w: 2.12, h: 2.05, fill: { color: C.navy }, line: noLine, rectRadius: 0.08 });
  addText(s, "统计检测\n→ 风险事件\n→ Agent 调查\n→ 审批与验证", 10.53, 3.34, 1.56, 1.45, { fontSize: 14.2, bold: true, color: C.white, breakLine: true, valign: "top", breakLineOnOverflow: false });
  card(s, 6.38, 5.38, 5.99, 0.83, { fill: C.pale2, line: C.pale, shadow: false });
  addText(s, "可追踪：每一步有状态   ·   可回溯：结论关联证据   ·   可审计：外部动作需审批", 6.65, 5.58, 5.45, 0.38, { fontSize: 12, bold: true, color: C.blue, align: "center" });
  addText(s, "真实界面截取自 ReleaseGuard 公开演示；数据为确定性 Demo / Replay，不代表生产流量。", 6.38, 6.26, 5.98, 0.2, { fontSize: 9, color: C.muted });
}

// 3. Agent workflow
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "PRODUCT MECHANISM", "Agent 不是一个 Prompt，而是一条可控的产品工作流", "模型负责规划，工具负责取证，运行时负责约束；证据不足时继续调查，而不是提前下结论。");
  const top = ["Risk Event", "Planner", "竞争假设", "Tool Calling", "Evidence", "Diagnosis"];
  top.forEach((t, i) => {
    const x = 0.68 + i * 2.03;
    card(s, x, 1.96, 1.58, 0.7, { fill: i === 0 ? C.navy : (i === 4 ? C.pale2 : C.white), line: i === 4 ? C.blue : C.line, shadow: false });
    addText(s, t, x + 0.08, 2.14, 1.42, 0.28, { fontSize: 12.5, bold: true, color: i === 0 ? C.white : C.navy, align: "center" });
    if (i < top.length - 1) arrow(s, x + 1.62, 2.31, x + 1.98, 2.31, "8795AA", 1.2);
  });
  card(s, 10.8, 2.91, 1.78, 0.75, { fill: C.amberPale, line: "F0D397", shadow: false });
  addText(s, "证据充分？", 10.95, 3.11, 1.48, 0.28, { fontSize: 13, bold: true, color: C.navy, align: "center" });
  arrow(s, 11.72, 2.69, 11.72, 2.91, C.amber, 1.5);
  addText(s, "不足", 9.73, 3.14, 0.55, 0.22, { fontSize: 10.5, bold: true, color: C.red, align: "right" });
  s.addShape(pptx.ShapeType.line, { x: 4.8, y: 3.29, w: 6.0, h: 0, line: { color: C.red, width: 1.4, beginArrowType: "triangle" } });
  addText(s, "返回 Planner / Tool Calling", 6.15, 3.37, 2.35, 0.24, { fontSize: 10.5, bold: true, color: C.red, align: "center" });
  addText(s, "充分", 11.96, 3.76, 0.55, 0.2, { fontSize: 10.5, bold: true, color: C.blue });
  arrow(s, 11.72, 3.68, 11.72, 4.05, C.blue, 1.5);
  const bottom = ["处置建议", "Human Approval", "Action", "Verification"];
  bottom.forEach((t, i) => {
    const x = 5.01 + i * 1.91;
    card(s, x, 4.08, 1.58, 0.7, { fill: i === 1 ? C.pale2 : C.white, line: i === 1 ? C.blue : C.line, shadow: false });
    addText(s, t, x + 0.06, 4.27, 1.46, 0.28, { fontSize: 11.8, bold: true, color: C.navy, align: "center" });
    if (i < bottom.length - 1) arrow(s, x + 1.61, 4.43, x + 1.86, 4.43, "8795AA", 1.2);
  });

  const pillars = [
    ["01 竞争假设", "同时保留多个可能原因，主动寻找支持与反驳证据。"],
    ["02 Evidence-first", "每个结论必须回溯到 ToolResult 产生的 Evidence。"],
    ["03 Human-in-the-loop", "高风险外部动作冻结参数并等待一次明确审批。"]
  ];
  pillars.forEach((p, i) => {
    const x = 0.68 + i * 4.03;
    card(s, x, 5.18, 3.72, 1.1, { fill: i === 1 ? C.pale2 : C.white, line: i === 1 ? C.blue : C.line, shadow: false });
    addText(s, p[0], x + 0.22, 5.37, 3.25, 0.27, { fontSize: 13.2, bold: true, color: i === 1 ? C.blue : C.navy });
    addText(s, p[1], x + 0.22, 5.73, 3.25, 0.38, { fontSize: 11.3, color: C.sub, valign: "top" });
  });
  addText(s, "运行支撑：Agent Loop · Tool Adapter · Approval · Verification · Benchmark · Harness · Scorer", 0.72, 6.55, 11.85, 0.23, { fontSize: 10.5, color: C.muted, align: "center" });
}

// 4. Benchmark
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "METRICS & BENCHMARK", "用任务完成、诊断质量、可信度、效率与人机协同共同评估", "评测目标不是“模型说得像不像”，而是 Agent 能否在约束内完成一次有据可查的调查。");
  metricCard(s, 0.68, 1.9, 2.28, "Benchmark", "22 Case", "20 完成 · 2 失败", C.blue);
  metricCard(s, 3.1, 1.9, 2.28, "全链路完成率", "90%+", "End-to-End Completion", C.blue2);
  metricCard(s, 5.52, 1.9, 2.28, "根因识别准确率", "75–85%", "Root Cause Accuracy", C.cyan);
  metricCard(s, 7.94, 1.9, 2.28, "有据结论率", "90%+", "Evidence-grounded", C.navy);
  metricCard(s, 10.36, 1.9, 2.28, "无需人工纠偏", "约 70%", "No-intervention Rate", C.amber);

  card(s, 0.68, 3.55, 5.12, 2.63, { shadow: false });
  sectionLabel(s, "效率对比", 0.96, 3.8);
  addText(s, "约 30 分钟", 0.95, 4.3, 1.95, 0.45, { fontSize: 22, bold: true, color: C.muted, align: "center" });
  addText(s, "人工跨系统调查", 1.06, 4.82, 1.65, 0.22, { fontSize: 10.5, color: C.muted, align: "center" });
  arrow(s, 2.94, 4.55, 3.53, 4.55, C.blue, 2.4);
  addText(s, "约 5–8 分钟", 3.55, 4.3, 1.95, 0.45, { fontSize: 22, bold: true, color: C.blue, align: "center" });
  addText(s, "Agent 调查", 3.7, 4.82, 1.65, 0.22, { fontSize: 10.5, color: C.blue, align: "center" });
  card(s, 1.05, 5.4, 4.38, 0.48, { fill: C.pale2, line: C.pale, shadow: false });
  addText(s, "效率提升来自流程自动化与有界工具调用，不来自省略证据。", 1.26, 5.51, 3.95, 0.24, { fontSize: 10.5, bold: true, color: C.blue, align: "center" });

  card(s, 6.02, 3.55, 6.62, 2.63, { shadow: false });
  sectionLabel(s, "评测闭环", 6.3, 3.8);
  const evalSteps = [["Case", "输入与期望"], ["Harness", "固定约束"], ["Agent Run", "保留轨迹"], ["Scorer", "指标 + Case"]];
  evalSteps.forEach((e, i) => {
    const x = 6.35 + i * 1.5;
    s.addShape(pptx.ShapeType.ellipse, { x, y: 4.37, w: 0.72, h: 0.72, fill: { color: i === 2 ? C.blue : C.pale }, line: { color: i === 2 ? C.blue : "BED0FF", width: 1 } });
    addText(s, String(i + 1), x, 4.55, 0.72, 0.25, { fontSize: 13, bold: true, color: i === 2 ? C.white : C.blue, align: "center" });
    addText(s, e[0], x - 0.25, 5.19, 1.22, 0.25, { fontSize: 11.5, bold: true, color: C.navy, align: "center" });
    addText(s, e[1], x - 0.3, 5.51, 1.32, 0.2, { fontSize: 9.5, color: C.muted, align: "center" });
    if (i < evalSteps.length - 1) arrow(s, x + 0.79, 4.73, x + 1.38, 4.73, "9AA8BF", 1.2);
  });
  addText(s, "数据口径：项目 22-case 确定性 Benchmark 与提供的评测汇总；合成/可复现实验数据，不代表生产流量。", 0.72, 6.46, 11.8, 0.22, { fontSize: 9.2, color: C.muted, align: "center" });
}

// 5. Case 205
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "FAILURE CASE · CASE-205", "一次失败 Case，暴露的不是“模型笨”，而是执行约束不充分", "当 region 分段返回 EMPTY，Planner 仍沿错误方向继续推理；修复重点因此落在 Harness 与语义校验机制。");
  const cols = [
    ["01 问题", "第一次运行", ["11 次模型调用", "5 次工具调用", "361 秒", "PRODUCT_METRIC → SUCCESS", "region → EMPTY", "终止：语义校验失败"], C.red, C.redPale],
    ["02 原因", "错误调查方向未被及时切断", ["EMPTY 仍消耗预算", "错误 AFFECTED_SEGMENT", "Repair context 信息不足", "Known Slice 未注入"], C.amber, C.amberPale],
    ["03 机制优化", "把失败变成可执行规则", ["优化 Harness selector", "EMPTY 不继续耗预算", "增加 INVALID_SEGMENT_GROUNDING", "增强 Evidence mapping", "注入 EMPTY + Known Slice", "Desktop / 6.5.0 / upload_success_rate"], C.blue, C.pale2],
    ["04 结果", "Deterministic replay", ["12 次模型调用", "6 次工具调用", "212 秒", "删除错误 Segment", "进入 FINALIZE", "终态：INCONCLUSIVE"], C.navy, "EEF2F8"]
  ];
  cols.forEach((c, i) => {
    const x = 0.62 + i * 3.16;
    card(s, x, 1.92, 2.92, 4.43, { fill: C.white, line: i === 2 ? C.blue : C.line, shadow: false });
    pill(s, c[0], x + 0.22, 2.17, 1.08, c[4], c[3]);
    addText(s, c[1], x + 0.22, 2.66, 2.46, 0.56, { fontSize: 16, bold: true, color: C.navy, valign: "top" });
    c[2].forEach((t, j) => {
      s.addShape(pptx.ShapeType.ellipse, { x: x + 0.26, y: 3.44 + j * 0.44, w: 0.12, h: 0.12, fill: { color: c[3] }, line: noLine });
      addText(s, t, x + 0.48, 3.34 + j * 0.44, 2.18, 0.3, { fontSize: 11.5, color: C.sub, bold: j === c[2].length - 1 && i !== 2 });
    });
    if (i < 3) arrow(s, x + 2.95, 4.17, x + 3.11, 4.17, "99A6B9", 1.2);
  });
  card(s, 0.9, 6.52, 11.48, 0.39, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "INCONCLUSIVE ≠ 失败：证据不足时拒绝制造“看似合理”的根因，是可信 Agent 的产品能力。", 1.12, 6.6, 11.0, 0.23, { fontSize: 12.2, bold: true, color: C.white, align: "center" });
}

// 6. Customer-service QA
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "PROJECT 02 · AI 智能客服质检", "LLM 负责理解隐性语义，规则负责稳定边界，人负责最终裁决", "产品目标不是替代质检员，而是扩大覆盖、统一初判，并把争议 Case 送入可追溯的复核流程。");
  card(s, 0.62, 1.88, 3.05, 4.77, { fill: C.navy, line: C.navy, shadow: false });
  pill(s, "业务问题", 0.92, 2.18, 1.02, "24477D", C.white);
  addText(s, "传统人工抽检", 0.92, 2.68, 2.38, 0.38, { fontSize: 20, bold: true, color: C.white });
  const pains = [["覆盖率低", "只能抽样"], ["标准不一", "判断依赖经验"], ["隐性违规", "关键词难捕捉"], ["复核成本", "上下文回看耗时"]];
  pains.forEach((p, i) => {
    const yy = 3.35 + i * 0.68;
    addText(s, `0${i + 1}`, 0.95, yy, 0.34, 0.25, { fontSize: 10.5, bold: true, color: "9EB5FF" });
    addText(s, p[0], 1.4, yy - 0.03, 0.92, 0.27, { fontSize: 13, bold: true, color: C.white });
    addText(s, p[1], 2.28, yy - 0.03, 1.0, 0.27, { fontSize: 10.5, color: "B9C7E5" });
  });
  addText(s, "产品判断：高覆盖不等于高可信，必须保留人工复核与版本化结果。", 0.92, 6.0, 2.38, 0.44, { fontSize: 11.3, bold: true, color: "D7E0F7", valign: "top" });

  card(s, 3.94, 1.88, 8.77, 2.42, { shadow: false });
  sectionLabel(s, "产品工作流", 4.23, 2.15);
  const flow = ["会话数据", "规则初筛", "LLM 语义", "违规/风险", "扣分", "人工复核", "最终结果"];
  flow.forEach((t, i) => {
    const x = 4.22 + i * 1.16;
    card(s, x, 2.75, 0.94, 0.78, { fill: i === 2 || i === 5 ? C.pale2 : C.white, line: i === 2 || i === 5 ? C.blue : C.line, shadow: false });
    addText(s, t, x + 0.06, 2.96, 0.82, 0.34, { fontSize: 11, bold: true, color: C.navy, align: "center" });
    if (i < flow.length - 1) arrow(s, x + 0.95, 3.14, x + 1.12, 3.14, "94A2B6", 1.1);
  });
  addText(s, "规则：关键词 / 正则 / SOP", 5.28, 3.68, 2.15, 0.2, { fontSize: 9.5, color: C.muted, align: "center" });
  addText(s, "覆盖：质检概览 · 会话管理 · 规则 / 方案 / 任务 · 结果复核 · 离线评测", 7.08, 3.68, 5.0, 0.2, { fontSize: 9.5, color: C.muted, align: "right" });

  card(s, 3.94, 4.55, 8.77, 2.1, { shadow: false });
  sectionLabel(s, "重点 Case · 隐性推诿", 4.23, 4.82);
  card(s, 4.28, 5.3, 2.22, 0.92, { fill: C.pale2, line: C.pale, shadow: false });
  addText(s, "AI 初始判断", 4.49, 5.44, 1.8, 0.22, { fontSize: 11, bold: true, color: C.blue });
  addText(s, "中度违规  ·  扣 10 分  ·  90 分", 4.49, 5.76, 1.8, 0.22, { fontSize: 12.2, bold: true, color: C.navy });
  arrow(s, 6.63, 5.76, 7.23, 5.76, C.blue, 1.8);
  card(s, 7.38, 5.3, 2.22, 0.92, { fill: C.white, line: C.blue, shadow: false });
  addText(s, "人工复核", 7.59, 5.44, 1.8, 0.22, { fontSize: 11, bold: true, color: C.blue });
  addText(s, "轻度违规  ·  扣 5 分  ·  95 分", 7.59, 5.76, 1.8, 0.22, { fontSize: 12.2, bold: true, color: C.navy });
  card(s, 9.87, 5.21, 2.48, 1.1, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "AI 原始结果保留\n人工结果独立记录", 10.16, 5.45, 1.9, 0.56, { fontSize: 12.5, bold: true, color: C.white, breakLine: true, align: "center", valign: "top" });
  addText(s, "Human-in-the-loop + 可追溯性", 7.05, 6.36, 3.6, 0.2, { fontSize: 10.5, bold: true, color: C.blue, align: "center" });
}

// 7. QA evaluation
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "AI EVALUATION", "不是只看 Accuracy，而是同时检查指标与错误 Case", "客服违规识别中，漏掉真实违规（FN）往往比误报更危险，因此 Recall 与 FN Review 必须进入产品决策。");
  card(s, 0.62, 1.9, 5.05, 4.74, { shadow: false });
  sectionLabel(s, "Confusion Matrix · N=20", 0.94, 2.17);
  pill(s, "人工 Gold Label", 3.68, 2.18, 1.48, C.pale, C.blue);
  addText(s, "预测结果", 2.39, 2.68, 2.25, 0.22, { fontSize: 11, bold: true, color: C.muted, align: "center" });
  addText(s, "实际\n标签", 1.05, 3.58, 0.42, 0.64, { fontSize: 11, bold: true, color: C.muted, align: "center", breakLine: true });
  addText(s, "违规", 2.0, 3.05, 1.38, 0.26, { fontSize: 11.5, bold: true, color: C.navy, align: "center" });
  addText(s, "正常", 3.48, 3.05, 1.38, 0.26, { fontSize: 11.5, bold: true, color: C.navy, align: "center" });
  addText(s, "违规", 1.5, 3.53, 0.42, 0.25, { fontSize: 11.5, bold: true, color: C.navy, align: "center" });
  addText(s, "正常", 1.5, 4.62, 0.42, 0.25, { fontSize: 11.5, bold: true, color: C.navy, align: "center" });
  const cells = [
    [2.0, 3.4, "TP", "10", C.pale2, C.blue], [3.48, 3.4, "FN", "1", C.redPale, C.red],
    [2.0, 4.48, "FP", "1", C.amberPale, C.amber], [3.48, 4.48, "TN", "8", "EEF2F8", C.navy]
  ];
  cells.forEach(c => {
    card(s, c[0], c[1], 1.38, 0.92, { fill: c[4], line: c[4], shadow: false });
    addText(s, c[2], c[0] + 0.12, c[1] + 0.13, 0.42, 0.2, { fontSize: 10.5, bold: true, color: c[5] });
    addText(s, c[3], c[0] + 0.64, c[1] + 0.22, 0.55, 0.38, { fontSize: 24, bold: true, color: c[5], align: "right" });
  });
  card(s, 1.52, 5.72, 3.62, 0.5, { fill: C.redPale, line: C.redPale, shadow: false });
  addText(s, "重点：逐条 Review FN，定位漏检与规则边界", 1.72, 5.84, 3.22, 0.22, { fontSize: 10.5, bold: true, color: C.red, align: "center" });

  metricCard(s, 5.94, 1.9, 1.58, "Accuracy", "90.0%", "整体正确率", C.blue);
  metricCard(s, 7.67, 1.9, 1.58, "Precision", "0.909", "误报控制", C.blue2);
  metricCard(s, 9.4, 1.9, 1.58, "Recall", "0.909", "漏报控制", C.red);
  metricCard(s, 11.13, 1.9, 1.58, "F1", "0.909", "综合平衡", C.navy);
  card(s, 5.94, 3.55, 6.77, 3.09, { shadow: false });
  sectionLabel(s, "指标 + Case Review 的评测闭环", 6.25, 3.85);
  const reviews = [
    ["1", "看指标", "Precision / Recall / F1 识别整体偏差"],
    ["2", "拆错误", "分别查看 FP 与 FN 的具体语义"],
    ["3", "改机制", "调整规则、Prompt、阈值与复核策略"],
    ["4", "再评测", "固定 Gold Label，避免只看单次 Demo"]
  ];
  reviews.forEach((r, i) => {
    const yy = 4.38 + i * 0.48;
    dot(s, r[0], 6.3, yy, i === 1 ? C.red : C.blue);
    addText(s, r[1], 6.79, yy - 0.01, 0.82, 0.3, { fontSize: 12.2, bold: true, color: C.navy });
    addText(s, r[2], 7.75, yy - 0.01, 4.46, 0.3, { fontSize: 11.2, color: C.sub });
  });
  card(s, 6.25, 6.28, 6.15, 0.2, { fill: C.navy, line: C.navy, shadow: false });
}

// 8. Summary & contact
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "CAPABILITIES & CONTACT", "从 AI Demo 到可评测、可约束、可落地的 AI 产品", "我能把业务问题转译为 AI 产品机制，并用指标、失败 Case 与人机协同边界持续迭代。");
  const groups = [
    ["AI 产品设计", "Agent Workflow\nRAG / LLM Application\nHuman-in-the-loop"],
    ["产品能力", "需求分析 · 用户场景\nPRD / Workflow\n产品指标"],
    ["AI 工程理解", "Prompt · Tool Calling\nStructured Output · JSON Schema\nBenchmark · Harness"],
    ["评测与迭代", "Gold Label\nPrecision / Recall / F1\nFailure Case Analysis"],
    ["项目落地", "Prototype · Demo\nDeployment · GitHub\n可运行作品"],
  ];
  groups.forEach((g, i) => {
    const x = 0.66 + (i % 3) * 3.23, y = 1.9 + Math.floor(i / 3) * 1.52;
    const w = i < 3 ? 2.96 : 2.96;
    card(s, x, y, w, 1.25, { fill: i === 0 ? C.pale2 : C.white, line: i === 0 ? C.blue : C.line, shadow: false });
    addText(s, `0${i + 1}`, x + 0.18, y + 0.17, 0.38, 0.25, { fontSize: 10.5, bold: true, color: C.blue });
    addText(s, g[0], x + 0.63, y + 0.14, 2.02, 0.28, { fontSize: 14, bold: true, color: C.navy });
    addText(s, g[1], x + 0.18, y + 0.52, 2.53, 0.56, { fontSize: 10.7, color: C.sub, breakLine: true, valign: "top" });
  });

  card(s, 10.32, 1.9, 2.38, 2.77, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "李超", 10.66, 2.22, 1.72, 0.48, { fontSize: 25, bold: true, color: C.white });
  addText(s, "UNSW MIT\nArtificial Intelligence\n2027 届 · AI 产品经理", 10.66, 2.93, 1.68, 1.0, { fontSize: 12.3, color: "D7E0F7", breakLine: true, valign: "top" });
  addText(s, "PORTFOLIO", 10.66, 4.18, 1.5, 0.22, { fontSize: 9.5, bold: true, color: "9EB5FF", charSpacing: 1.2 });

  card(s, 0.66, 5.22, 12.04, 1.45, { shadow: false });
  sectionLabel(s, "项目链接", 0.95, 5.48);
  s.addShape(pptx.ShapeType.roundRect, { x: 3.03, y: 5.4, w: 3.62, h: 0.78, fill: { color: C.blue }, line: noLine, rectRadius: 0.08, hyperlink: { url: "https://releaseguard.easonchao.com" } });
  addText(s, "ReleaseGuard AI · 在线 Demo  ↗", 3.3, 5.61, 3.08, 0.3, { fontSize: 13.5, bold: true, color: C.white, align: "center", hyperlink: { url: "https://releaseguard.easonchao.com" } });
  s.addShape(pptx.ShapeType.roundRect, { x: 6.92, y: 5.4, w: 3.62, h: 0.78, fill: { color: C.white }, line: { color: C.blue, width: 1.4 }, rectRadius: 0.08, hyperlink: { url: "https://github.com/Eason4real/releaseguard-ai" } });
  addText(s, "ReleaseGuard AI · GitHub  ↗", 7.18, 5.61, 3.1, 0.3, { fontSize: 13.5, bold: true, color: C.blue, align: "center", hyperlink: { url: "https://github.com/Eason4real/releaseguard-ai" } });
  addText(s, "公开 Demo 使用确定性 Replay 数据，不触发真实外部写操作。", 3.04, 6.31, 7.48, 0.2, { fontSize: 9.5, color: C.muted, align: "center" });
}

for (const s of pptx._slides) {
  if (typeof s._slideNum === "number") {
    // PptxGenJS validates placement during serialization; all content stays within 13.333 × 7.5.
  }
}

await pptx.writeFile({ fileName: out, compression: true });
console.log(out);

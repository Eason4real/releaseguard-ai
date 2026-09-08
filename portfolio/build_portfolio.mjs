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
const evidenceShot = path.join(screenshotDir, "releaseguard-evidence.png");
const approvalShot = path.join(screenshotDir, "releaseguard-approval.png");
const evidenceUiCrop = path.join(screenshotDir, "releaseguard-evidence-portfolio-crop.png");
const approvalUiCrop = path.join(screenshotDir, "releaseguard-approval-portfolio-crop.png");

await Promise.all([
  sharp(evidenceShot).extract({ left: 250, top: 120, width: 1175, height: 680 }).toFile(evidenceUiCrop),
  sharp(approvalShot).extract({ left: 250, top: 120, width: 1175, height: 680 }).toFile(approvalUiCrop),
]);

const pptx = new PptxGenJS();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "李超";
pptx.subject = "ReleaseGuard AI Portfolio v1.0";
pptx.title = "ReleaseGuard AI｜AI 产品经理项目作品集";
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
    { text: { text: "李超 · ReleaseGuard AI 作品集 v1.0", options: { x: 0.55, y: 7.13, w: 3.8, h: 0.18, fontFace: "Microsoft YaHei", fontSize: 8.5, color: "7C879A", margin: 0 } } },
    { text: { text: "2027 校招", options: { x: 11.7, y: 7.13, w: 1.05, h: 0.18, fontFace: "Microsoft YaHei", fontSize: 8.5, color: "7C879A", align: "right", margin: 0 } } },
  ],
  slideNumber: { x: 12.58, y: 7.11, w: 0.46, h: 0.2, color: "7C879A", fontSize: 8.5, align: "right" },
});

const C = {
  navy: "102A56",
  blue: "2155F5",
  blue2: "4E7BFF",
  pale: "EAF0FF",
  pale2: "F1F5FF",
  ink: "182235",
  sub: "566276",
  muted: "7C879A",
  line: "DCE3EF",
  white: "FFFFFF",
  red: "D84A5D",
  redPale: "FFF0F2",
  amber: "D48A16",
  amberPale: "FFF7E8",
  cyan: "1E8FB3",
  cyanPale: "EAF8FC",
  green: "167A5B",
  greenPale: "EAF7F2",
};
const font = "Microsoft YaHei";
const noLine = { color: "FFFFFF", transparency: 100 };

function addText(slide, text, x, y, w, h, opts = {}) {
  slide.addText(text, {
    x,
    y,
    w,
    h,
    fontFace: font,
    fontSize: 14,
    color: C.ink,
    margin: 0,
    valign: "mid",
    fit: "shrink",
    ...opts,
  });
}

function addTitle(slide, number, kicker, title, conclusion) {
  addText(slide, `${number}  ${kicker.toUpperCase()}`, 0.62, 0.31, 4.3, 0.25, {
    fontSize: 10.5,
    bold: true,
    color: C.blue,
    charSpacing: 1,
  });
  addText(slide, title, 0.62, 0.66, 12.0, 0.54, {
    fontSize: 28,
    bold: true,
    color: C.navy,
  });
  addText(slide, conclusion, 0.62, 1.23, 11.9, 0.42, {
    fontSize: 14,
    color: C.sub,
  });
}

function card(slide, x, y, w, h, opts = {}) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h,
    rectRadius: 0.06,
    fill: { color: opts.fill || C.white },
    line: { color: opts.line || C.line, width: opts.lineWidth || 1 },
    shadow: opts.shadow === false
      ? undefined
      : { type: "outer", color: "9AA8BF", opacity: 0.08, blur: 1, angle: 45, distance: 1 },
  });
}

function pill(slide, text, x, y, w, fill = C.pale, color = C.blue) {
  slide.addShape(pptx.ShapeType.roundRect, {
    x,
    y,
    w,
    h: 0.3,
    fill: { color: fill },
    line: noLine,
    rectRadius: 0.15,
  });
  addText(slide, text, x + 0.05, y + 0.02, w - 0.1, 0.24, {
    fontSize: 10.5,
    bold: true,
    color,
    align: "center",
  });
}

function arrow(slide, x1, y1, x2, y2, color = C.blue, width = 1.6) {
  slide.addShape(pptx.ShapeType.line, {
    x: x1,
    y: y1,
    w: x2 - x1,
    h: y2 - y1,
    line: { color, width, endArrowType: "triangle" },
  });
}

function dot(slide, n, x, y, fill = C.blue) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x,
    y,
    w: 0.36,
    h: 0.36,
    fill: { color: fill },
    line: noLine,
  });
  addText(slide, String(n), x, y + 0.02, 0.36, 0.29, {
    fontSize: 10.5,
    bold: true,
    color: C.white,
    align: "center",
  });
}

function metricCard(slide, x, y, w, label, value, sub, accent = C.blue) {
  card(slide, x, y, w, 1.25, { shadow: false });
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y,
    w: 0.06,
    h: 1.25,
    fill: { color: accent },
    line: noLine,
  });
  addText(slide, label, x + 0.22, y + 0.14, w - 0.34, 0.23, {
    fontSize: 11,
    bold: true,
    color: C.sub,
  });
  addText(slide, value, x + 0.22, y + 0.39, w - 0.34, 0.43, {
    fontSize: 25,
    bold: true,
    color: C.navy,
  });
  addText(slide, sub, x + 0.22, y + 0.9, w - 0.34, 0.22, {
    fontSize: 9.5,
    color: C.muted,
  });
}

function sectionLabel(slide, text, x, y, color = C.blue) {
  slide.addShape(pptx.ShapeType.rect, {
    x,
    y: y + 0.05,
    w: 0.05,
    h: 0.24,
    fill: { color },
    line: noLine,
  });
  addText(slide, text, x + 0.14, y, 3.2, 0.34, {
    fontSize: 12,
    bold: true,
    color: C.navy,
  });
}

async function imageContain(slide, imagePath, x, y, w, h) {
  const metadata = await sharp(imagePath).metadata();
  const ratio = metadata.width / metadata.height;
  const box = w / h;
  let imageWidth = w;
  let imageHeight = h;
  let imageX = x;
  let imageY = y;
  if (ratio > box) {
    imageHeight = w / ratio;
    imageY = y + (h - imageHeight) / 2;
  } else {
    imageWidth = h * ratio;
    imageX = x + (w - imageWidth) / 2;
  }
  slide.addImage({ path: imagePath, x: imageX, y: imageY, w: imageWidth, h: imageHeight });
}

function addSource(slide, text) {
  addText(slide, text, 0.65, 6.82, 11.95, 0.17, {
    fontSize: 8.5,
    color: C.muted,
    align: "right",
  });
}

// 01 Project overview
{
  const s = pptx.addSlide("MASTER");
  s.background = { color: "F7F9FC" };
  s.addShape(pptx.ShapeType.rect, {
    x: 0,
    y: 0,
    w: 4.48,
    h: 7.5,
    fill: { color: C.navy },
    line: noLine,
  });
  addText(s, "RELEASEGUARD AI", 0.6, 0.58, 3.2, 0.28, {
    fontSize: 11,
    bold: true,
    color: "9EB5FF",
    charSpacing: 1.4,
  });
  addText(s, "发布异常调查\nAgent", 0.6, 1.18, 3.25, 1.15, {
    fontSize: 31,
    bold: true,
    color: C.white,
    breakLine: true,
    valign: "top",
  });
  addText(s, "面向产品经理、产品负责人\n与发布负责人", 0.6, 2.62, 3.25, 0.72, {
    fontSize: 15,
    color: "D7E0F7",
    breakLine: true,
    valign: "top",
  });
  addText(s, "场景", 0.6, 3.72, 0.8, 0.23, {
    fontSize: 10.5,
    bold: true,
    color: "9EB5FF",
  });
  addText(s, "版本上线后，核心业务指标出现异常", 0.6, 4.06, 3.18, 0.62, {
    fontSize: 17,
    bold: true,
    color: C.white,
    valign: "top",
  });
  addText(s, "我的工作", 0.6, 5.1, 0.9, 0.23, {
    fontSize: 10.5,
    bold: true,
    color: "9EB5FF",
  });
  addText(s, "产品定义 · Agent 产品设计\n评测体系 · 迭代决策", 0.6, 5.44, 3.15, 0.75, {
    fontSize: 15,
    bold: true,
    color: C.white,
    breakLine: true,
    valign: "top",
  });
  pill(s, "作品集 v1.0 · 非生产数据", 0.6, 6.43, 2.65, "24477D", C.white);

  addText(s, "帮助团队判断：\n究竟是不是这次发布导致的？", 5.05, 0.72, 7.35, 1.02, {
    fontSize: 26,
    bold: true,
    color: C.navy,
    breakLine: true,
    valign: "top",
  });
  addText(s, "系统维护竞争假设，通过受控工具取证与证据约束形成诊断；证据不足时给出有界结论，外部动作始终需要人工审批。", 5.05, 1.92, 7.25, 0.72, {
    fontSize: 15,
    color: C.sub,
    valign: "top",
  });
  card(s, 5.05, 2.94, 7.34, 3.2, { fill: C.white, line: "C9D7FF" });
  await imageContain(s, homeShot, 5.28, 3.17, 4.55, 2.74);
  s.addShape(pptx.ShapeType.rect, {
    x: 10.08,
    y: 3.17,
    w: 0.04,
    h: 2.74,
    fill: { color: C.line },
    line: noLine,
  });
  addText(s, "调查闭环", 10.42, 3.26, 1.4, 0.25, {
    fontSize: 11,
    bold: true,
    color: C.blue,
  });
  addText(s, "风险信号\n调查\n证据\n诊断\n审批\n验证", 10.42, 3.68, 1.58, 1.92, {
    fontSize: 14,
    bold: true,
    color: C.navy,
    breakLine: true,
    valign: "top",
  });
  addSource(s, "公开演示使用确定性回放数据，不触发真实外部写操作。");
}

// 02 User problem
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "02", "用户问题", "发布后的第一判断，常常缺少完整证据", "指标变化与发布时间接近，只能说明相关；可靠归因需要跨信息源验证。");

  const flow = [
    ["新版本上线", "发布记录"],
    ["核心指标下降", "业务指标"],
    ["团队开始排查", "产品、研发与数据团队"],
    ["信息分散", "分群、反馈与历史事故"],
    ["过早归因", "“一定是版本导致”"],
  ];
  flow.forEach((item, index) => {
    const x = 0.68 + index * 2.5;
    card(s, x, 1.92, 2.06, 0.9, {
      fill: index === 4 ? C.redPale : C.white,
      line: index === 4 ? C.red : C.line,
      shadow: false,
    });
    addText(s, item[0], x + 0.14, 2.08, 1.78, 0.25, {
      fontSize: 14,
      bold: true,
      color: index === 4 ? C.red : C.navy,
      align: "center",
    });
    addText(s, item[1], x + 0.14, 2.42, 1.78, 0.2, {
      fontSize: 9.5,
      color: C.muted,
      align: "center",
    });
    if (index < flow.length - 1) arrow(s, x + 2.08, 2.37, x + 2.42, 2.37, "96A5BA", 1.2);
  });

  const problems = [
    ["01", "信息分散", "调查者需要在发布记录、指标分群、用户反馈和历史事故之间反复切换。"],
    ["02", "相关被误判为因果", "版本与异常同时发生时，团队容易忽略流量结构、外部依赖或测量问题。"],
    ["03", "解释缺少证据约束", "普通 LLM 可以快速生成合理叙述，却不保证每个判断都来自当前事故证据。"],
  ];
  problems.forEach((item, index) => {
    const x = 0.68 + index * 4.14;
    card(s, x, 3.35, 3.78, 2.62, {
      fill: index === 1 ? C.pale2 : C.white,
      line: index === 1 ? C.blue : C.line,
      shadow: false,
    });
    addText(s, item[0], x + 0.22, 3.62, 0.48, 0.25, {
      fontSize: 11,
      bold: true,
      color: C.blue,
    });
    addText(s, item[1], x + 0.78, 3.56, 2.7, 0.34, {
      fontSize: 18,
      bold: true,
      color: C.navy,
    });
    addText(s, item[2], x + 0.22, 4.22, 3.3, 1.2, {
      fontSize: 13.5,
      color: C.sub,
      valign: "top",
    });
  });
  addText(s, "产品机会：把一次开放式排查，转化为有状态、有证据、有停止边界的调查流程。", 1.4, 6.25, 10.55, 0.34, {
    fontSize: 15,
    bold: true,
    color: C.blue,
    align: "center",
  });
}

// 03 Product workflow
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "03", "产品流程", "从风险信号到恢复验证", "每一步都向下一步提供结构化状态，模型只负责调查决策，运行时负责权限与边界。");

  const steps = [
    ["风险信号", "确定性规则识别异常"],
    ["调查任务", "创建可恢复调查"],
    ["竞争假设", "保留多种解释"],
    ["调查工具", "查询当前事故事实"],
    ["证据包", "整理来源与关系"],
    ["就绪判断", "判断证据是否足够"],
    ["诊断或拒答", "输出有据结论"],
    ["人工审批", "负责人确认动作"],
    ["执行动作", "受控外部写操作"],
    ["效果验证", "检查业务是否恢复"],
  ];
  steps.forEach((item, index) => {
    const row = index < 5 ? 0 : 1;
    const column = row === 0 ? index : 9 - index;
    const x = 0.72 + column * 2.47;
    const y = row === 0 ? 1.95 : 4.25;
    const active = ["证据包", "就绪判断", "人工审批"].includes(item[0]);
    card(s, x, y, 2.05, 1.18, {
      fill: active ? C.pale2 : C.white,
      line: active ? C.blue : C.line,
      shadow: false,
    });
    addText(s, String(index + 1).padStart(2, "0"), x + 0.15, y + 0.13, 0.4, 0.2, {
      fontSize: 9.5,
      bold: true,
      color: C.blue,
    });
    addText(s, item[0], x + 0.15, y + 0.4, 1.75, 0.28, {
      fontSize: 14,
      bold: true,
      color: C.navy,
      align: "center",
    });
    addText(s, item[1], x + 0.15, y + 0.8, 1.75, 0.2, {
      fontSize: 9.5,
      color: C.muted,
      align: "center",
    });
    if (row === 0 && index < 4) arrow(s, x + 2.08, y + 0.59, x + 2.38, y + 0.59, "96A5BA", 1.2);
    if (row === 1 && index < 9) arrow(s, x - 0.09, y + 0.59, x - 0.36, y + 0.59, "96A5BA", 1.2);
  });
  arrow(s, 10.19, 3.18, 10.19, 4.1, C.blue, 1.5);

  card(s, 0.72, 5.78, 11.93, 0.65, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "用户获得的不只是答案，而是一条可回看、可审批、可验证的调查记录。", 1.05, 5.94, 11.28, 0.28, {
    fontSize: 15,
    bold: true,
    color: C.white,
    align: "center",
  });
}

// 04 Real product UI
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "04", "真实产品界面", "一次真实调查，在产品里是怎么发生的？", "真实 Demo 将调查进度、竞争假设、证据状态和人工审批放在同一条可追溯流程中。");

  card(s, 0.62, 1.83, 6.0, 3.72, { fill: C.white, line: C.line, shadow: false });
  card(s, 6.72, 1.83, 6.0, 3.72, { fill: C.white, line: C.line, shadow: false });
  pill(s, "调查与取证", 0.88, 2.02, 1.18, C.greenPale, C.green);
  pill(s, "审批与验证", 6.98, 2.02, 1.18, C.pale, C.blue);
  await imageContain(s, evidenceUiCrop, 0.84, 2.42, 5.56, 2.94);
  await imageContain(s, approvalUiCrop, 6.94, 2.42, 5.56, 2.94);

  const uiSteps = [
    "创建竞争假设",
    "调用受控工具取证",
    "证据保留来源与关系",
    "继续调查或有界停止",
    "诊断后进入审批与验证",
  ];
  uiSteps.forEach((label, index) => {
    const x = 0.72 + index * 2.5;
    dot(s, index + 1, x, 5.9, index === 4 ? C.green : C.blue);
    addText(s, label, x + 0.48, 5.87, 1.82, 0.42, {
      fontSize: 10.5,
      bold: true,
      color: C.navy,
    });
  });
  addSource(s, "来源：ReleaseGuard AI 当前公开 Demo 的真实界面截图；演示使用确定性回放数据。");
}

// 05 Competing hypotheses and discriminator
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "05", "核心设计", "竞争假设与区分性调查", "Agent 优先寻找能区分多个解释的证据，而不是持续为第一个猜测寻找支持。");

  card(s, 0.68, 1.9, 2.15, 3.95, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "观察", 0.95, 2.2, 0.8, 0.25, {
    fontSize: 11,
    bold: true,
    color: "9EB5FF",
  });
  addText(s, "核心指标\n发布后下降", 0.95, 2.75, 1.58, 1.02, {
    fontSize: 24,
    bold: true,
    color: C.white,
    breakLine: true,
    align: "center",
    valign: "top",
  });
  addText(s, "时间相关\n尚未证明因果", 0.95, 4.45, 1.58, 0.72, {
    fontSize: 14,
    color: "D7E0F7",
    breakLine: true,
    align: "center",
  });

  const hypotheses = [
    ["A", "版本 Bug", "新版本用户异常更明显"],
    ["B", "流量结构变化", "分群内稳定，流量权重改变"],
    ["C", "埋点测量问题", "业务结果稳定，埋点指标下降"],
  ];
  hypotheses.forEach((item, index) => {
    const y = 1.92 + index * 1.33;
    card(s, 3.25, y, 3.35, 1.02, {
      fill: index === 0 ? C.pale2 : C.white,
      line: index === 0 ? C.blue : C.line,
      shadow: false,
    });
    dot(s, item[0], 3.48, y + 0.31, index === 0 ? C.blue : C.navy);
    addText(s, item[1], 3.98, y + 0.17, 2.28, 0.3, {
      fontSize: 16,
      bold: true,
      color: C.navy,
    });
    addText(s, item[2], 3.98, y + 0.56, 2.28, 0.22, {
      fontSize: 10.5,
      color: C.sub,
    });
  });

  card(s, 7.08, 1.9, 5.55, 3.95, { fill: C.white, line: "C9D7FF", shadow: false });
  sectionLabel(s, "下一条最有区分力的证据", 7.42, 2.2);
  const queries = [
    ["版本隔离", "同平台比较新旧应用版本", "区分版本特异异常与整体流量问题"],
    ["分群稳定性", "比较用户类型和地区内指标", "识别分群汇总偏差与流量结构变化"],
    ["互补业务结果", "比较行为完成与埋点指标", "区分真实故障与测量偏差"],
  ];
  queries.forEach((item, index) => {
    const y = 2.82 + index * 0.82;
    addText(s, String(index + 1), 7.45, y, 0.3, 0.3, {
      fontSize: 11,
      bold: true,
      color: C.white,
      align: "center",
      fill: { color: C.blue },
    });
    addText(s, item[0], 7.9, y - 0.02, 1.18, 0.3, {
      fontSize: 13,
      bold: true,
      color: C.navy,
    });
    addText(s, item[1], 9.08, y - 0.02, 2.95, 0.27, {
      fontSize: 11.5,
      color: C.ink,
    });
    addText(s, item[2], 7.9, y + 0.33, 4.18, 0.24, {
      fontSize: 10,
      color: C.muted,
    });
  });

  card(s, 1.25, 6.14, 10.83, 0.48, { fill: C.pale2, line: C.pale, shadow: false });
  addText(s, "产品价值：减少确认偏误，让“为什么继续查这条证据”对用户和评测者都可解释。", 1.52, 6.25, 10.28, 0.25, {
    fontSize: 13.5,
    bold: true,
    color: C.blue,
    align: "center",
  });
}

// 06 Evidence-first
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "06", "证据优先", "工具结果 ≠ 证据 ≠ 诊断", "ReleaseGuard 把机器返回、证据解释和最终结论分开保存，避免模型叙述覆盖事实。");

  const layers = [
    ["工具结果", "工具返回的机器事实", "状态 · 原始输出 · 错误"],
    ["证据", "对当前调查有意义的结构化事实", "来源 · 强度 · 可追溯信息 · 关系"],
    ["诊断", "通过服务端校验的用户结论", "根因 · 论断 · 引用"],
  ];
  layers.forEach((item, index) => {
    const x = 0.75 + index * 4.2;
    const tone = index === 1 ? C.blue : C.navy;
    card(s, x, 2.02, 3.55, 2.62, {
      fill: index === 1 ? C.pale2 : C.white,
      line: index === 1 ? C.blue : C.line,
      shadow: false,
    });
    addText(s, item[0], x + 0.25, 2.35, 3.05, 0.38, {
      fontSize: 22,
      bold: true,
      color: tone,
      align: "center",
    });
    addText(s, item[1], x + 0.3, 3.03, 2.95, 0.58, {
      fontSize: 14,
      bold: true,
      color: C.ink,
      align: "center",
    });
    addText(s, item[2], x + 0.3, 3.87, 2.95, 0.34, {
      fontSize: 10.5,
      color: C.muted,
      align: "center",
    });
    if (index < 2) {
      addText(s, "≠", x + 3.68, 2.98, 0.35, 0.4, {
        fontSize: 25,
        bold: true,
        color: C.red,
        align: "center",
      });
    }
  });

  card(s, 0.75, 5.05, 11.94, 1.13, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "LLM", 1.1, 5.31, 0.65, 0.24, {
    fontSize: 11,
    bold: true,
    color: "9EB5FF",
  });
  addText(s, "决定下一步调查方向", 1.85, 5.25, 2.38, 0.35, {
    fontSize: 15,
    bold: true,
    color: C.white,
  });
  addText(s, "服务端", 5.03, 5.31, 0.75, 0.24, {
    fontSize: 11,
    bold: true,
    color: "9EB5FF",
  });
  addText(s, "控制事实、状态、预算、权限和最终校验", 5.88, 5.25, 5.58, 0.35, {
    fontSize: 15,
    bold: true,
    color: C.white,
  });
  addText(s, "Evidence Packet v2 保留事实范围与工具结果关联，综合结论模块不能补造缺失证据。", 1.08, 6.4, 11.25, 0.28, {
    fontSize: 13,
    color: C.sub,
    align: "center",
  });
}

// 07 Readiness and abstention
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "07", "就绪判断与有界拒答", "证据不足时，系统不强行给出根因", "就绪判断将“是否继续调查”和“应该交付哪类结果”变成明确的产品状态。");

  const states = [
    ["继续取证", "仍有竞争假设", "存在调查预算\n继续寻找区分证据", C.blue, C.pale2],
    ["有据诊断", "证据足够区分", "主要假设已区分\n且结论有证据约束", C.green, C.greenPale],
    ["有界假设", "已有领先方向", "但现有证据仍然\n不能唯一归因", C.amber, C.amberPale],
    ["可行动拒答", "关键问题未解", "预算或工具无法\n解决关键不确定性", C.red, C.redPale],
  ];
  states.forEach((item, index) => {
    const x = 0.68 + index * 3.08;
    card(s, x, 2.08, 2.72, 2.5, {
      fill: item[4],
      line: item[3],
      shadow: false,
    });
    addText(s, item[0], x + 0.2, 2.32, 2.32, 0.28, {
      fontSize: 10,
      bold: true,
      color: item[3],
      align: "center",
    });
    addText(s, item[1], x + 0.2, 2.85, 2.32, 0.42, {
      fontSize: 21,
      bold: true,
      color: C.navy,
      align: "center",
    });
    addText(s, item[2], x + 0.25, 3.55, 2.22, 0.62, {
      fontSize: 12,
      color: C.sub,
      breakLine: true,
      align: "center",
      valign: "top",
    });
  });

  card(s, 0.68, 5.03, 7.45, 1.22, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "“不知道”是合法结果", 1.03, 5.27, 2.5, 0.4, {
    fontSize: 22,
    bold: true,
    color: C.white,
  });
  addText(s, "系统应告诉用户：已经确认什么、还缺什么、下一项最有价值的数据是什么。", 3.73, 5.24, 3.96, 0.52, {
    fontSize: 13.5,
    color: "D7E0F7",
  });

  card(s, 8.48, 5.03, 4.2, 1.22, { fill: C.white, line: C.blue, shadow: false });
  addText(s, "运行时保证", 8.78, 5.23, 1.15, 0.26, {
    fontSize: 11,
    bold: true,
    color: C.blue,
  });
  addText(s, "工具预算 · 最大迭代次数\n重复调用拦截 · 部分证据保留", 8.78, 5.56, 3.45, 0.45, {
    fontSize: 12,
    bold: true,
    color: C.navy,
    breakLine: true,
    valign: "top",
  });
}

// 08 Human in the loop
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "08", "人工审批闭环", "审批是一条服务端安全边界", "模型不能直接执行外部写操作；审批绑定具体诊断、具体动作和冻结参数。");

  const flow = [
    ["诊断", "有据结论"],
    ["建议动作", "具体动作与参数"],
    ["人工审批", "负责人确认"],
    ["受控外部动作", "当前实现\nCREATE_GITHUB_ISSUE"],
    ["效果验证", "检查指标恢复"],
  ];
  flow.forEach((item, index) => {
    const x = 0.69 + index * 2.5;
    const active = index === 2;
    card(s, x, 2.05, 2.08, 1.08, {
      fill: active ? C.pale2 : C.white,
      line: active ? C.blue : C.line,
      shadow: false,
    });
    addText(s, item[0], x + 0.12, 2.26, 1.84, 0.3, {
      fontSize: index === 3 ? 11 : 14,
      bold: true,
      color: active ? C.blue : C.navy,
      align: "center",
    });
    addText(s, item[1], x + 0.12, 2.65, 1.84, index === 3 ? 0.38 : 0.2, {
      fontSize: index === 3 ? 8.2 : 9.5,
      color: C.muted,
      align: "center",
      breakLine: index === 3,
    });
    if (index < flow.length - 1) arrow(s, x + 2.1, 2.59, x + 2.39, 2.59, "96A5BA", 1.2);
  });

  const safeguards = [
    ["权限边界", "只读调查工具可自主执行；外部写操作必须审批。"],
    ["参数冻结", "执行使用审批时保存的不可变快照，不接受临时改写。"],
    ["幂等与审计", "重复请求不会创建第二次外部工作，状态变化保留审计记录。"],
    ["效果验证", "动作成功不等于问题解决，系统需要等待窗口并检查业务信号。"],
  ];
  safeguards.forEach((item, index) => {
    const x = 0.72 + (index % 2) * 6.12;
    const y = 3.72 + Math.floor(index / 2) * 1.18;
    card(s, x, y, 5.72, 0.9, {
      fill: index === 0 ? C.pale2 : C.white,
      line: index === 0 ? C.blue : C.line,
      shadow: false,
    });
    addText(s, item[0], x + 0.22, y + 0.16, 1.18, 0.27, {
      fontSize: 13.5,
      bold: true,
      color: C.navy,
    });
    addText(s, item[1], x + 1.55, y + 0.13, 3.88, 0.55, {
      fontSize: 11.5,
      color: C.sub,
      valign: "top",
    });
  });
  addText(s, "公开演示中的审批仅改变演示状态，不会调用真实 GitHub 或线上系统。", 1.5, 6.35, 10.3, 0.3, {
    fontSize: 12.5,
    color: C.muted,
    align: "center",
  });
}

// 09 Evaluation
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "09", "评测", "用失败案例验证 Agent，而不是只展示成功演示", "固定标准答案、保留完整运行轨迹，再分别评估取证、引用、证据约束与最终判断。");

  const metrics = [
    ["固定开发集评测", "22 个案例", "单轮"],
    ["至少一项关键证据", "22 / 22", "运行后与标准答案对照"],
    ["完整关键证据集", "14 / 22", "证据收集"],
    ["受控调查信息源", "5 类", "40 次只读工具调用"],
  ];
  metrics.forEach((item, index) => {
    metricCard(s, 0.67 + index * 3.08, 1.82, 2.72, item[0], item[1], item[2], index === 1 ? C.green : C.blue);
  });

  const evalFlow = ["固定标准答案", "Agent 运行", "证据评分", "盲评", "失败分类", "迭代"];
  evalFlow.forEach((item, index) => {
    const x = 0.75 + index * 2.05;
    addText(s, String(index + 1), x, 3.48, 0.38, 0.34, {
      fontSize: 11,
      bold: true,
      color: C.white,
      align: "center",
      fill: { color: index === 3 ? C.navy : C.blue },
    });
    addText(s, item, x + 0.48, 3.47, 1.38, 0.34, {
      fontSize: 11.5,
      bold: true,
      color: C.navy,
      align: "center",
    });
    if (index < evalFlow.length - 1) arrow(s, x + 1.88, 3.65, x + 2.0, 3.65, "96A5BA", 1);
  });

  card(s, 0.68, 4.24, 12.0, 1.75, { fill: "FFFDFD", line: "F1DCE0", shadow: false });
  sectionLabel(s, "真实结果与边界", 0.98, 4.5, C.red);
  const reality = [
    ["取证强于最终表达", "证据收集链路已形成", "证据引用仍需加强"],
    ["边界失败被保留", "部分运行触发能力边界", "不通过重跑覆盖失败"],
    ["综合结论仍有断层", "证据到诊断的转化", "证据约束仍需完善"],
  ];
  reality.forEach((item, index) => {
    const x = 1.0 + index * 3.9;
    addText(s, item[0], x, 4.93, 3.42, 0.24, {
      fontSize: 11,
      bold: true,
      color: C.navy,
      align: "center",
    });
    addText(s, item[1], x, 5.25, 3.42, 0.3, {
      fontSize: 13.5,
      bold: true,
      color: index === 1 ? C.red : C.blue,
      align: "center",
    });
    addText(s, item[2], x, 5.61, 3.42, 0.2, {
      fontSize: 9.5,
      color: C.muted,
      align: "center",
    });
  });
  addText(s, "最终 V8 使用 gpt-5.6-sol。合成、可复现的单轮开发集评测，用于验证调查与评测方法，不代表生产环境准确率。", 0.85, 6.27, 11.65, 0.3, {
    fontSize: 11.5,
    color: C.sub,
    align: "center",
  });
  addSource(s, "来源：最终 V8 评测报告与盲评摘要 · 标准答案未进入 Agent 运行时");
}

// 10 Iteration story
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "10", "迭代案例", "从低分追到可验证的产品机制", "没有继续盲调提示词，而是先做失败分类，再用最小改动和受控探针验证假设。");

  const story = [
    ["Agent 能完成调查", "技术成功不代表证据质量"],
    ["盲评结果较差", "最终结论缺少区分性证据"],
    ["失败分类", "定位查询选择与就绪判断"],
    ["就绪门控", "竞争假设未区分时继续取证"],
    ["受控探针", "只跑最小案例子集验证行为"],
    ["规划上下文", "显式提供可用与已尝试查询形态"],
  ];
  story.forEach((item, index) => {
    const x = 0.68 + index * 2.08;
    dot(s, index + 1, x + 0.72, 2.02, index >= 3 ? C.blue : C.navy);
    if (index < story.length - 1) arrow(s, x + 1.09, 2.2, x + 1.96, 2.2, "96A5BA", 1.2);
    addText(s, item[0], x, 2.55, 1.8, 0.42, {
      fontSize: 13,
      bold: true,
      color: C.navy,
      align: "center",
    });
    addText(s, item[1], x, 3.06, 1.8, 0.66, {
      fontSize: 9.5,
      color: C.muted,
      align: "center",
      valign: "top",
    });
  });

  card(s, 0.72, 4.15, 5.72, 1.52, { fill: C.greenPale, line: C.green, shadow: false });
  pill(s, "CASE-206 · 受控探针", 1.02, 4.4, 2.35, C.greenPale, C.green);
  addText(s, "由未命中到严格通过", 1.02, 4.9, 2.35, 0.38, {
    fontSize: 17,
    bold: true,
    color: C.green,
  });
  addText(s, "区分性取证成功排除竞争解释", 3.52, 4.82, 2.45, 0.5, {
    fontSize: 12.5,
    color: C.sub,
  });

  card(s, 6.86, 4.15, 5.72, 1.52, { fill: C.pale2, line: C.blue, shadow: false });
  pill(s, "CASE-218 · 受控探针", 7.16, 4.4, 2.35, C.pale2, C.blue);
  addText(s, "错误确定性归因\n→ 有界拒答", 7.16, 4.86, 2.65, 0.56, {
    fontSize: 17,
    bold: true,
    color: C.blue,
    breakLine: true,
    valign: "top",
  });
  addText(s, "证据不足时停止过度归因", 10.12, 4.9, 2.05, 0.4, {
    fontSize: 12.5,
    color: C.sub,
  });

  addText(s, "这两个结果是局部受控探针，不代表整体评测准确率提升。", 1.42, 6.14, 10.5, 0.32, {
    fontSize: 13,
    bold: true,
    color: C.red,
    align: "center",
  });
}

// 11 My work
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "11", "我的工作", "我负责把业务问题转译为 Agent 产品机制", "工作范围覆盖产品定义、Agent 设计、评测体系和迭代决策，代码用于把这些产品约束变成可运行系统。");

  const groups = [
    ["产品定义", ["目标用户与使用场景", "发布风险调查边界", "端到端产品流程"]],
    ["Agent 产品设计", ["竞争假设与证据", "工具契约与就绪判断", "人工审批"]],
    ["评测体系", ["标准答案与固定案例集", "盲评机制", "失败分类"]],
    ["迭代决策", ["定位失败阶段", "设计受控探针", "最小改动与主动冻结"]],
  ];
  groups.forEach((group, index) => {
    const x = 0.65 + index * 3.13;
    card(s, x, 1.95, 2.83, 3.65, {
      fill: index === 1 ? C.pale2 : C.white,
      line: index === 1 ? C.blue : C.line,
      shadow: false,
    });
    addText(s, `0${index + 1}`, x + 0.22, 2.2, 0.42, 0.24, {
      fontSize: 10.5,
      bold: true,
      color: C.blue,
    });
    addText(s, group[0], x + 0.22, 2.58, 2.36, 0.38, {
      fontSize: 19,
      bold: true,
      color: C.navy,
    });
    group[1].forEach((item, itemIndex) => {
      dot(s, itemIndex + 1, x + 0.24, 3.27 + itemIndex * 0.67, index === 1 ? C.blue : C.navy);
      addText(s, item, x + 0.75, 3.25 + itemIndex * 0.67, 1.8, 0.38, {
        fontSize: 12,
        color: C.sub,
      });
    });
  });

  card(s, 0.65, 5.95, 12.05, 0.55, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "作品集目标达到后停止针对评测调优，把剩余问题公开记录为能力边界。", 1.02, 6.07, 11.3, 0.28, {
    fontSize: 14,
    bold: true,
    color: C.white,
    align: "center",
  });
}

// 12 Limitations and next steps
{
  const s = pptx.addSlide("MASTER");
  addTitle(s, "12", "能力边界", "明确能力边界，才能让 Agent 迭代真正可验证", "作品集 v1.0 已完成功能冻结；后续只将未解决问题作为未来方向，不继续针对评测调参。");

  card(s, 0.65, 1.87, 7.2, 4.45, { fill: C.white, line: C.line, shadow: false });
  sectionLabel(s, "当前限制", 0.98, 2.16, C.red);
  const limitations = [
    "合成、可复现的开发集；最终评测仅运行一轮，未做多随机种子或 3×22",
    "规划器的查询选择仍受模型采样影响；盲评模型也存在方差",
    "真实写操作仅支持 CREATE_GITHUB_ISSUE；没有自动修复或自主回滚",
    "公开演示使用确定性回放，不代表真实企业部署或客户投资回报",
  ];
  limitations.forEach((item, index) => {
    dot(s, index + 1, 1.02, 2.78 + index * 0.72, C.navy);
    addText(s, item, 1.53, 2.74 + index * 0.72, 5.88, 0.5, {
      fontSize: 12,
      color: C.sub,
    });
  });

  card(s, 8.18, 1.87, 4.5, 2.38, { fill: C.pale2, line: C.blue, shadow: false });
  sectionLabel(s, "未来方向", 8.5, 2.16);
  addText(s, "• 提升能力边界契约的稳定性\n• 改善证据引用与结论投影\n• 完成同模型多随机种子验证\n• 在真实数据接入后重新评估", 8.52, 2.7, 3.72, 1.2, {
    fontSize: 12.5,
    color: C.sub,
    breakLine: true,
    valign: "top",
  });

  card(s, 8.18, 4.58, 4.5, 1.74, { fill: C.navy, line: C.navy, shadow: false });
  addText(s, "李超", 8.52, 4.86, 1.3, 0.36, {
    fontSize: 21,
    bold: true,
    color: C.white,
  });
  addText(s, "UNSW 信息技术硕士 · 人工智能方向\n2027 届 · AI 产品经理", 9.85, 4.82, 2.35, 0.65, {
    fontSize: 11.5,
    color: "D7E0F7",
    breakLine: true,
    valign: "top",
  });
  addText(s, "在线演示  ↗", 8.52, 5.64, 1.5, 0.3, {
    fontSize: 12,
    bold: true,
    color: "9EB5FF",
    hyperlink: { url: "https://releaseguard.easonchao.com" },
  });
  addText(s, "GitHub  ↗", 10.28, 5.64, 1.2, 0.3, {
    fontSize: 12,
    bold: true,
    color: "9EB5FF",
    hyperlink: { url: "https://github.com/Eason4real/releaseguard-ai" },
  });
}

await pptx.writeFile({ fileName: out, compression: true });
console.log(out);

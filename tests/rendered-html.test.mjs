import assert from "node:assert/strict";
import test from "node:test";

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /业务概览/);
  assert.match(html, /风险调查/);
  assert.match(html, /最佳实践/);
  assert.match(html, /href=["']\/best-practice["']/);
  assert.match(html, /评测报告/);
  assert.match(html, /href=["']\/benchmark["']/);
  assert.match(html, /第一次体验？/);
  assert.match(html, /3 分钟完成一次发布风险调查/);
  assert.match(html, /href=["']\/guided-experience["']/);
  assert.match(html, /下单转化率异常下降/);
  assert.match(html, /3\.3 个百分点/);
  assert.match(html, /相对下降/);
  assert.match(html, /26\.6%/);
  assert.match(html, /相对降幅和持续时间均超过团队预设标准/);
  assert.match(html, /15%/);
  assert.match(html, /公开演示/);
  assert.match(html, /业务优先/);
  assert.doesNotMatch(html, /PUBLIC_DEMO|BUSINESS FIRST|TECHNICAL DETAILS/);
  assert.match(html, /先理解业务过程，再按需查看技术细节/);
  assert.match(html, /演示环境就绪/);
  assert.doesNotMatch(html, /LLM/);
  assert.doesNotMatch(html, /API Key|Fine-grained access token|Eason4real|releaseguard-demo/);
});

test("renders the generated benchmark viewer without hard-coded result claims", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("benchmark-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/benchmark", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /正在载入可审计评测结果/);
  assert.match(html, /页面只读取生成的 summary\.json/);
  assert.doesNotMatch(html, /真实企业生产数据.*22 个公开事故/);
  assert.doesNotMatch(html, /API Key|Fine-grained access token/);
});

test("renders the business-facing best practice scenario", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("best-practice-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/best-practice", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  const sections = [
    "发生了什么？",
    "为什么系统发现了风险？",
    "Agent 为什么提出这些可能原因？",
    "Agent 如何寻找证据？",
    "Agent 如何从证据得到根因？",
    "为什么需要人工审批？",
    "执行后如何验证恢复？",
    "ReleaseGuard AI 完成了什么？",
  ];

  assert.match(html, /酒店推荐策略发布后，下单转化率异常下降/);
  for (const section of sections) assert.ok(html.includes(section), `missing section: ${section}`);
  assert.match(html, /12\.4%/);
  assert.match(html, /9\.1%/);
  assert.match(html, /3\.3 个百分点/);
  assert.match(html, /相对下降/);
  assert.match(html, /26\.6%/);
  assert.match(html, /相对过去 7 日基线下降 ≥15%/);
  assert.match(html, /0\.35/);
  assert.match(html, /0\.55/);
  assert.match(html, /99\.96%/);
  assert.match(html, /风险标准由业务团队提前设定，AI 负责发现异常后的调查/);
  assert.match(html, /等待人工审批/);
  assert.match(html, /验证通过/);
  assert.match(html, /演示案例 · 非生产数据/);
  assert.match(html, /不会触发真实 Agent 或线上操作/);
  assert.match(html, /href=["']\/guided-experience["']/);
  for (const explanation of [
    "为什么触发风险？",
    "风险标准由业务团队提前设定，AI 负责发现异常后的调查",
    "为什么是这三个调查方向？",
    "为什么越来越支持新版排序策略？",
    "为什么基本排除库存\/价格服务？",
    "为什么基本排除用户流量结构？",
    "为什么优先建议回滚？",
    "回滚不是唯一正确方案",
    "为什么认为问题已经恢复？",
    "查看依据",
    "当前证据不支持",
  ]) assert.match(html, new RegExp(explanation));
  assert.match(html, /发布前为 .*31%/);
  assert.doesNotMatch(html, /API Key|Fine-grained access token/);
});

test("renders the five-step guided experience from the canonical scenario", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("guided-experience-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/guided-experience", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  for (const step of [
    "发生了什么？",
    "AI 在怀疑什么？",
    "AI 找到了什么？",
    "建议怎么办？",
    "问题解决了吗？",
  ]) assert.ok(html.includes(step), `missing guided step: ${step}`);

  assert.match(html, /第 .*1.* 步，共 .*5.* 步/);
  assert.match(html, /12\.4%/);
  assert.match(html, /9\.1%/);
  assert.match(html, /3\.3 个百分点/);
  assert.match(html, /相对下降/);
  assert.match(html, /26\.6%/);
  assert.match(html, /v3\.8\.0/);
  assert.match(html, /开始调查/);
  assert.match(html, /新版发布/);
  assert.match(html, /约 2 小时/);
  assert.match(html, /酒店下单转化率出现明显异常/);
  assert.doesNotMatch(html, /酒店新版发布后，下单转化率从/);
  for (const explanation of [
    "为什么触发风险？",
    "风险标准由业务团队提前设定，AI 负责发现异常后的调查",
    "查看依据",
  ]) assert.match(html, new RegExp(explanation));
  assert.doesNotMatch(html, /LLM/);
  assert.match(html, /新手案例：酒店推荐策略异常 · 非生产数据/);
  assert.match(html, /与真实 Agent 运行环境、审批和线上操作隔离/);
  assert.doesNotMatch(html, /Risk Event ID|Deterministic Rule|Competitive Hypothesis|Evidence Matrix/);
});

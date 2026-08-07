# ReleaseGuard AI

面向软件版本上线后异常调查与处置场景的可审计 AI Agent Demo。

ReleaseGuard 把一次发布风险调查拆成可检查的业务链路：

异常发现 -> Agent 调查 -> 竞争性假设 -> 工具调用 -> 证据归因 -> 根因诊断 -> 人工审批 -> 动作执行 -> 恢复验证

## Demo

首页默认是 `PUBLIC_DEMO`，HR 或面试官打开链接即可体验，无需登录，也不需要填写任何 API Key。

这是确定性的 Demo / Replay 数据，不是生产数据，也不会在公开模式下调用真实 LLM、GitHub 或 D1。页面可以逐步播放完整调查，也可以查看故障注入回放，观察规划校验失败后的有界修复路径。

Demo link: 部署完成后填写

推荐展示文字：`在线 Demo -> 非生产 Replay 数据 -> 不触发真实外部写操作`

## What This Demonstrates

- Deterministic risk detection with baseline, sample-size, and consecutive-window rules.
- One Investigation Agent with structured Planner decisions and bounded tool budgets.
- Competing hypotheses with supporting and contradicting evidence links.
- Auditable ToolCall, ToolResult, Evidence, diagnosis, approval, action, and verification records.
- Human approval for the implemented `CREATE_GITHUB_ISSUE` write action.
- Historical incident retrieval with a deterministic local/CI fallback and hosted vector path.
- Public Demo mode that keeps state in browser memory and blocks shared-data, model, and external-write APIs.

The fixture is based on an Android release-risk investigation. It is synthetic and reproducible; similar incidents are clues for hypothesis formation, never proof of the current root cause.

## Stack

- Next.js `16.2.6` App Router conventions with React `19.2.6`.
- Vinext `0.0.50` and Vite `8.0.13` for the Cloudflare Worker build.
- TypeScript `5.9.3`, Drizzle ORM `0.45.2`, and Wrangler `4.92.0`.
- Node.js `>=22.13.0`; npm with the committed `package-lock.json`.
- Cloudflare D1 is the hosted source of truth for `PRIVATE_LIVE`; local and CI runs use the configured simulation/fallback.

## Run Locally

```bash
npm ci
cp .env.example .env
npm run dev
```

The default mode is safe for a public demo:

```bash
RELEASEGUARD_DEPLOYMENT_MODE=PUBLIC_DEMO npm run dev
```

`PRIVATE_LIVE` is for one trusted, access-controlled operator only. It requires the existing D1 schema and any model/GitHub credentials to be provided as deployment secrets; never commit those values.

## Verification

```bash
npm run tsc
npm run lint
npm test
npm run eval
```

The repository includes a 22-case deterministic investigation benchmark and focused regression coverage for the runtime, approval boundary, verification, risk detection, and retrieval layers. The latest verified `npm test` run in this checkout passed 328/328 checks (1 production-bundle check, 324 runtime checks, and 3 rendered-page checks). Synthetic fixtures and evaluation outputs must not be presented as private production data.

## Deployment Notes

The standard verified build produces a full-stack Sites/Worker artifact under `dist/`, including `dist/server/index.js` with an ESM `default.fetch` export. The application is not a plain static export: App Router pages and API routes are part of the runtime.

For Tencent EdgeOne Pages, use the native Next.js build, which has been verified separately without changing the standard Vinext build. Import the GitHub repository and use:

- Framework preset: `Next.js`.
- Install command: `npm install` (or `npm ci` if the builder supports the lockfile).
- Build command: `npm run build:edgeone`.
- Output directory: `.next`.
- Node version: `22` or newer, matching `package.json`.
- Environment variables for a public demo: `RELEASEGUARD_DEPLOYMENT_MODE=PUBLIC_DEMO` and `RELEASEGUARD_SCHEMA_MODE=EXPLICIT`.

The three public portfolio pages are prerendered by Next.js, while the existing API routes remain available to a Pages Functions/SSR-capable deployment. If the selected EdgeOne project type only accepts static files, switch to its Next.js full-stack project type. Do not remove API routes or switch to a fake static shell just to make a build pass.

GitHub Pages is not suitable for this artifact because it cannot execute the Worker/API runtime.

## Security Boundary

`.env*`, local databases, logs, build output, Wrangler state, and runtime reports are ignored. Public Demo mode has no credential input surface and rejects all shared-state, model, GitHub, and verification APIs with a server-owned `PUBLIC_DEMO_OPERATION_DISABLED` response. Keep `PRIVATE_LIVE` behind access control and rotate any credential immediately if one is ever exposed.

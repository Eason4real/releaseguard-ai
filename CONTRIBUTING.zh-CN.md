# Contributing to ReleaseGuard AI

[English](CONTRIBUTING.md) | 简体中文

感谢你关注 ReleaseGuard AI。项目欢迎可复现的问题、公开事故案例、评测改进和小范围工程贡献。

## 提交 Issue 前

- 搜索现有 Issue，避免重复提交。
- 对产品或评测问题，说明预期行为、实际行为和复现步骤。
- 对事故案例，提供公开来源、可用于调查的输入、最终根因依据和可能的答案泄漏风险。
- 不要提交 API Key、Token、Cookie、私有日志、客户数据或其他敏感信息。

## 本地开发

```bash
npm ci
cp .env.example .env
npm run dev
```

默认使用 `PUBLIC_DEMO` 或本地确定性回退。除非你明确拥有权限，不要连接生产 D1 或真实外部系统。

## 变更要求

1. 保持单一 Investigation Agent、结构化状态、原子工具和人工审批边界。
2. 不把 LLM 输出当作权限、审批或状态流转的权威来源。
3. 不保存隐藏思维链；只保存公开理由、假设、观察和证据引用。
4. 不为通过 Benchmark 硬编码 `case_id`、事故名称或 Gold Label。
5. 对行为变更添加聚焦的回归测试。
6. 保持公开 Fixture、离线模拟和生产数据之间的明确区分。

## 文档翻译

英文文档是内容源。已存在简体中文镜像时，影响文档行为的变更应在同一个 Pull Request 中同步更新中文版本。翻译必须保持能力声明、已知限制、命令、链接和安全边界一致。

## 提交前验证

```bash
npm run tsc
npm run lint
npm test
npm run eval
npm run eval:investigation-dev-harness
```

Live LLM Eval 依赖外部凭证，不作为普通 Pull Request 的强制检查。若运行过，请在 PR 中记录模型、参数、Commit和原始结果位置。

## Pull Request

- 使用简洁、具体的标题。
- 说明问题、方案、风险和验证结果。
- 一个 PR 只解决一个连贯问题。
- 不提交 `.env`、密钥、`node_modules`、构建产物、数据库、运行日志或缓存。

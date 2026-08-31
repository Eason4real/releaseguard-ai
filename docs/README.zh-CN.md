# ReleaseGuard AI Documentation

[English](README.md) | 简体中文

这组文档面向产品、工程、评测和安全读者。建议根据目的选择入口，而不是按文件名顺序阅读。

## 快速阅读

| 你想了解什么 | 推荐文档 |
| --- | --- |
| 产品解决什么问题、服务谁、边界在哪里 | [PRODUCT_SPEC.md（英文）](PRODUCT_SPEC.md) |
| Agent Loop、Planner、工具、证据和审批如何协作 | [AGENT_ARCHITECTURE.md（英文）](AGENT_ARCHITECTURE.md) |
| 当前如何评测、哪些指标可信、如何复现 | [EVALUATION.zh-CN.md](EVALUATION.zh-CN.md) |
| 数据、Fixture和长期评测方向 | [DATA_AND_EVAL.md（英文）](DATA_AND_EVAL.md) |
| 未来产品优先级 | [../ROADMAP.zh-CN.md](../ROADMAP.zh-CN.md) |
| 安全问题与报告方式 | [../SECURITY.zh-CN.md](../SECURITY.zh-CN.md) |

## Benchmark 参考（英文）

- [数据集规范](investigation-benchmark-dataset-spec.md)
- [评分契约](investigation-benchmark-evaluation-contract.md)
- [Runner设计](investigation-benchmark-runner-phase1b.md)
- [开发Harness](investigation-benchmark-dev-harness-phase1c4a.md)
- [Live Adapter](investigation-benchmark-live-adapter-phase1c4b0b.md)
- [Live Preflight](investigation-benchmark-live-preflight-phase1c4b0c1.md)
- [可观测性](investigation-benchmark-observability.md)

这些带阶段编号的文件是实现决策记录，不是产品功能清单。是否已实现以当前代码、自动化测试和主README为准。

## Public corpus（英文）

- [真实公开语料V1](real-public-corpus-v1.md)
- [公开事故语料设计](real-world-corpus.md)

公开事故和半合成Fixture用于离线评测与检索验证，不代表企业私有生产数据。

## 文档约束

- 不把未来目标描述成已实现能力。
- 不把确定性回退描述为托管语义检索。
- 不把公开Replay描述为Live Agent执行。
- 不公开隐藏思维链、凭证、私有日志或客户数据。
- 相似历史事故只能帮助形成假设，不能直接证明当前根因。

# ReleaseGuard AI Evaluation

## 1. 评测目标

ReleaseGuard的评测不只判断“最终答案像不像”，而是检查一次调查是否能够在受控预算内完成、是否引用有效证据、是否保留不确定性，以及运行时能否守住工具和审批边界。

当前仓库提供三类验证：

1. **运行时回归测试**：状态机、工具、证据、审批、执行、验证、风险检测和检索行为。
2. **确定性离线评测**：无需外部模型凭证，可在CI中重复运行。
3. **Live LLM评测**：使用配置的外部模型，单独记录模型、参数、Token、耗时和原始结果，不作为无凭证CI的强制Gate。

## 2. 数据范围

调查Benchmark当前包含22个公开事故重建或确定性Fixture案例。每个案例将Agent可见输入与评测专用Ground Truth分离，包含：

- 事故问题与风险上下文；
- 可供工具访问的证据Fixture；
- 标准根因与可接受表达；
- 必需支持证据、其他支持证据和干扰证据；
- 因果回答或正确保留结论的预期模式；
- 难度、类别和语义评分规则。

数据位于：

```text
eval/investigation-benchmark/dataset/
```

公开数据、Fixture和评测输出均不得表述为企业私有生产数据。

## 3. 答案泄漏控制

- Ground Truth、标准根因和语义Rubric只供Scorer使用，不进入Planner输入、工具上下文、Observation或持久化调查状态。
- Runner通过独立Execution Input构建Agent可见输入。
- 历史事故相似性只能作为假设线索，不能直接作为当前根因证据。
- 如果语料中出现能够直接揭示当前案例答案的复盘内容，该案例必须隔离、重构或明确标记为检索复盘测试。
- 数据集和语义规则均生成Hash，用于识别评测前后的数据变化。

详细契约见 [investigation-benchmark-evaluation-contract.md](investigation-benchmark-evaluation-contract.md)。

## 4. 指标定义

### Root Cause Top-1

先判断预期和预测是明确因果结论还是保留结论，再依次进行稳定ID、精确别名和受控语义Rubric匹配。

- 错误ID不能通过相似文本补救。
- 因果案例中的泛化“证据不足”不算正确。
- 保留结论案例中的确定性归因不算正确。
- 不能自动确定的边界案例进入 `REVIEW_REQUIRED`，不会被静默计为正确或错误。

报告必须同时展示自动评测覆盖率、正确数、错误数、待复核数和运行失败数，不能只展示一个百分比。

### Evidence Precision

唯一支持证据引用数 ÷ 全部唯一引用数。干扰项和未知Evidence ID保留在分母中；零引用的Precision为0。

### Unsupported Claim Rate

在可机器验证的事实性诊断Claim中，`UNGROUNDED` Claim所占比例。旧版不可验证Claim不会被推断为已支持，而是标记为不可评测。

### Investigation Cost

记录实际模型调用数、工具调用数、端到端耗时和可获得的Token信息。缺失Token不会被估算。

### Reliability

对相同数据和配置进行重复运行时，比较流程完成、最终根因、证据引用和语义Hash的一致性。确定性Harness默认运行两次并要求结果Hash一致。

## 5. 当前对照设计

正式公开报告应在冻结数据集和相同输入条件下比较：

| 方案 | 说明 |
| --- | --- |
| Direct LLM | 一次性获得允许的静态上下文，不使用Agent Loop和动态工具选择 |
| Current Agent | 改进前的ReleaseGuard Agent |
| Improved Agent | 根据冻结Benchmark错误切片改进后的Agent |
| Fixed Workflow（可选） | 仅在仓库存在可解释的固定流程时使用；不得为凑对照而伪造 |

当前仓库已具备Current Agent、确定性Provider和Live Adapter。未实际执行并保存原始输出的方案，不会在README中展示结果。

## 6. 复现命令

完整的无凭证验证：

```bash
npm ci
npm run tsc
npm run lint
npm test
npm run eval
npm run eval:investigation-dev-harness
```

局部评测：

```bash
npm run eval:rag
npm run eval:rag:real
npm run eval:investigation-dev-harness
```

Live LLM评测需要单独配置：

```bash
LIVE_EVAL_API_KEY=...
LIVE_EVAL_BASE_URL=...
LIVE_EVAL_MODEL=...
npm run eval:investigation-live
```

不要把凭证写入命令历史、报告、Issue或源码。Live运行必须记录Commit、模型、参数和结果文件，未运行的测试明确标记为未运行。

## 7. 结果发布要求

正式结果应至少公开：

- 测试Commit和运行时间；
- 数据集与语义规则Hash；
- 模型、Provider和解码参数；
- 每个方案的原始运行记录；
- 每案例预测、证据、评分和评分原因；
- 聚合指标及原始分子/分母；
- 失败类型、待人工复核队列和已知限制；
- 可重复执行的命令。

不得通过删除失败案例、修改Gold Label、硬编码答案或只报告最佳一次运行来提高结果。

## 8. 已知限制

- 22个案例只能支持项目级离线比较，不能证明企业生产环境普适性。
- 公开历史事故可能已经出现在模型预训练语料中；运行时答案隔离不能完全消除预训练记忆风险。
- 确定性Provider验证Harness和评分稳定性，不等于验证真实模型能力。
- LLM-as-Judge若使用同一模型，必须标注为非独立评审；当前确定性语义评分不冒充人工审核。
- 端到端Agent运行时间不能直接推导真实人工节省时间。

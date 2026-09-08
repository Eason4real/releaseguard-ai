# ReleaseGuard Portfolio v1.0 - Final V8 Failure Analysis

## 评测边界

Final V8 使用 22 个固定、合成且可复现的 DEV cases，进行一次单轮 Portfolio benchmark。评测用于检查 Agent 调查流程、Evidence Collection 和失败边界，不代表生产环境准确率，也不支持真实客户效果或 ROI 声明。

公开结果聚焦以下可核验事实：

- 22 / 22 cases 至少收集一项 Gold key evidence；该指标表示关键证据触达率为 100%。
- 14 / 22 cases 收集完整 Gold key-evidence set；该指标表示完整关键证据覆盖率约为 64%。
- Agent 共执行 40 次受控、只读 investigation tool calls。

## 评测方法

```text
Fixed Gold Dataset
-> Agent Run
-> Evidence Scoring
-> Blind Judge
-> Failure Taxonomy
-> Iteration
```

Gold 仅在运行完成后用于 scorer 和 judge，不进入 Agent runtime。Blind Judge 用于提供一致的语义评审信号，但它本身也是 LLM evaluator，需要结合 case trace 和 failure taxonomy 理解。

## 主要发现

### Evidence Collection 强于最终表达

Agent 已能通过受控工具在所有案例中触达至少一项关键证据，但已收集事实没有稳定进入最终 citation。当前主要断层位于 Evidence 到可核验 Diagnosis 的投影过程，而不是单纯的工具可用性。

### Limitation contract 暴露运行边界

部分案例在 limitation contract 边界被终止。这些运行作为有效失败保留，没有通过重跑或调参覆盖。它们说明 runtime contract 仍需更清晰地区分合法拒答、结构错误和可继续调查的状态。

### Grounded synthesis 仍需进一步验证

Final V8 支持继续研究 citation projection 与 grounded synthesis，但现有单轮数据不足以证明大规模稳定性。项目在 Portfolio v1.0 达到功能冻结后停止 benchmark tuning，把剩余问题记录为 Future Work。

## Failure Taxonomy

- **Citation / projection：**已收集证据没有稳定进入最终引用。
- **Limitation boundary：**部分合法或可恢复路径被 contract 中断。
- **Synthesizer grounding：**最终判断没有稳定保留 Evidence 中的机制、对象与因果边界。
- **Query selection：**单次 LLM 采样可能选择信息增益不足的查询。
- **Bounded abstention：**证据不足时安全停止是合法结果，不能简单视为错误因果诊断。

## 已知限制

- single-run，未运行 multi-seed 或 3×22；
- Blind Judge 存在语义标准与采样方差；
- fixture 是合成、可复现数据，不是真实企业私有数据；
- 当前唯一外部写操作是经过人工审批的 `CREATE_GITHUB_ISSUE`；
- Public Demo 不代表企业生产部署。

评测协议与指标定义见 [Evaluation Methodology](methodology.md) 和 [Investigation Benchmark Contract](../investigation-benchmark-evaluation-contract.md)。完整原始结果继续保留为内部实验 artifacts，不作为招聘主阅读路径。

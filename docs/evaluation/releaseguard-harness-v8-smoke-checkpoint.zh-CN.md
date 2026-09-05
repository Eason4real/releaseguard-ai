# ReleaseGuard AI Harness v8：17 案例 Smoke 检查点

> 日期：2026-09-04  
> 性质：受治理 Dev 集上的研发检查点，不是 Holdout、生产准确率或 v8 正式成绩  
> 数据边界：复用 v7 冻结工具轨迹；Synthesizer 只读取净化后的 Agent-plane 文件，盲评在模型输出完成后独立读取 Gold

## 一、结论

v8 已解决本轮最主要的技术交付问题，但尚未通过进入 22 案例评测的业务门槛。

- `contract-v2` 技术成功 17/17（100%），达到目标 `>=97%`；
- 最终关键证据引用 14/17（82.4%），达到目标 `>=80%`；
- 独立盲评严格 2 分 6/17（35.3%），达到 smoke 目标 `>=35%`；
- 独立盲评宽松 1-2 分 9/17（52.9%），未达到目标 `>=65%`；
- 20 次 Synthesizer 调用，0 次调查工具调用；17 个最终结果全部通过服务端契约；
- 未检测到 Gold、案例编号、关键证据清单或评分字段进入 Synthesizer 输入。

因此当前决策是：**不进入 22 案例，更不启动 3x22 正式评测。** 下一阶段只验证 Collector 的假设、证据选择和 Evidence Assessment 改进。

## 二、两次 Smoke 的意义

第一批 smoke 保留了 17 个结果，其中 11 个因 JSON、缺失 disposition 或 grounding 不合法而失败。29 次 Provider 请求全部成功，因此失败不属于额度、网络或模型服务故障，而属于 Synthesizer 契约和服务端兼容问题。

`contract-v2` 没有覆盖第一批结果，而是使用独立结果文件与源码哈希重新验证。它增加了：

- 四态 readiness 对终态的明确约束；
- 精确 validation code/path 与 Packet 内合法 Evidence ID 提示；
- 主调用与唯一修复仍失败时，服务端生成合法 `STOP_INCONCLUSIVE`，保留 Evidence；
- 每轮公开模型响应与校验结果的可观测记录；
- 完整空检索作为有意义负证据的结构化表达。

结果从 6/17 技术成功提升到 17/17，说明技术交付瓶颈已经基本解除。

## 三、剩余 8 个 0 分的归因

| 类型 | 案例数 | 说明 |
| --- | ---: | --- |
| 缺少区分机制的关键观测 | 5 | 冻结轨迹没有采集必要的反馈、技术信号、互补指标或历史证据，Synthesizer 无法补造事实 |
| Evidence Assessment 方向错误 | 2 | Collector 将“事件指标下降但业务完成稳定”错误解释为真实行为或平台故障，而非测量/埋点问题 |
| 相关性被升级为因果 | 1 | 仅凭发布修改了相关模块和异常同时出现，就将发布假设标为 SUPPORTED，未排除外部依赖 |

这说明当前主要瓶颈已经从 Harness 技术协议转移到 Collector 的调查质量。基础模型仍是变量，但现有证据不足以把失败主要归因于模型能力上限。

## 四、已实施的下一步修复

Collector 和 readiness 已增加通用约束，不包含案例 ID 或 Gold 规则：

1. 发布记录只证明变更存在、范围和时间；没有版本隔离、暴露/控制差异、机制或结果差异时只能标为 `NEUTRAL`。
2. `relation` 必须和公开 explanation 一致，说明“反驳”时必须使用 `CONTRADICTS`。
3. 异常指标与互补业务结果不一致时，必须比较埋点/口径问题与真实行为变化。
4. 尚未被当前事件证据反驳的可行替代假设会阻止 `READY_FOR_CAUSAL`。
5. 领先假设必须得到 `PRODUCT_METRIC` 或 `SEGMENT_METRIC` 的直接支持；发布上下文本身不够。
6. 有工具预算时，未区分的替代假设会返回 `NEEDS_COLLECTION`，要求继续采集高信息增益证据。

## 五、下一验证阶段

下一次验证应生成新的 Collector 轨迹，重点验证：

- 是否主动采集能区分发布回归、外部依赖、流量结构和测量问题的观测；
- Evidence Assessment 是否避免把“可能相关”写成 `SUPPORTS`；
- 互补指标是否被正确用于区分真实用户行为和埋点异常；
- 未检验的替代假设是否会触发继续采集，而不是过早综合；
- Collector 技术结构成功、EMPTY、模型调用、工具调用、tokens 和延迟是否仍在预算内。

只有该阶段证明 Collector 改进，并使 17 案例的宽松盲评达到 `>=65%`，才允许进入 22 案例单轮 smoke。

## 六、产物

- `evaluation/results/v8/smoke/input/agent-input.json`
- `evaluation/results/v8/smoke/input/evaluator-manifest.json`
- `evaluation/results/v8/smoke/raw/synthesis-attempts.jsonl`（第一批失败基线）
- `evaluation/results/v8/smoke/raw/synthesis-attempts-contract-v2.jsonl`
- `evaluation/results/v8/smoke/score-contract-v2.json`
- `evaluation/results/v8/smoke/judge-contract-v2.jsonl`
- `evaluation/results/v8/smoke/contract-v2.source.sha256`

所有失败均保留；没有覆盖 v1-v7 正式结果，没有把 Dev 称为 Holdout，也没有向 Agent/Synthesizer 泄露 Gold。

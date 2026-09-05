# ReleaseGuard AI Harness v8 完整改进方案

> 文档用途：v8 研发、验证和评测的统一执行依据  
> 输入依据：v7 正式 Dev 评测 66 条轨迹、离线损失分解、17 案例 Synthesizer 反事实实验  
> 文档边界：这是研发方案，不代表 v8 已实现或已达到指标

## 一、决策摘要

v8 应继续采用“单 Agent、服务端状态、分阶段调查”的总体架构，不回退到自由 Agent Loop，也不引入 Multi-Agent。需要重做的是阶段之间的信息契约和产品输出，而不是推翻整个运行时。

本版本只解决四个核心问题：

1. 让 Collector 找到的具体事实完整进入 Evidence Packet；
2. 让 Synthesizer 稳定输出符合服务端 grounding 规则的结果；
3. 将二态 Gate 改成四态 readiness，允许明确因果、有界假设和可行动拒答；
4. 让每次调查无论是否能归因，都向产品经理交付可消费的调查结果。

本版本不增加自动回滚、不扩展写工具、不放宽 grounding、不更换基础模型，也不直接运行完整 3×22。先通过 17 案例 smoke 门槛，再决定是否冻结和启动正式评测。

## 二、问题基线

### 2.1 正式 v7 结果

| 指标 | v7 | 问题判断 |
| --- | ---: | --- |
| 技术完成率 | 66/66，100% | 基础运行稳定性已解决 |
| 明确诊断交付 | 1/66，1.5% | 产品价值严重不足 |
| 严格根因 | 7/60，11.7% | 完整机制判断不足 |
| 宽松根因 | 7/60，11.7% | 正确方向未能进入最终答案 |
| 关键证据召回 | 68.9% | Collector 已找到相当一部分信息 |
| EMPTY 工具比例 | 18/154，11.7% | 可优化，但不是首要瓶颈 |
| 工具错误 | 0 | 工具执行不是主因 |
| 终态一致性 | 21/22，95.5% | 系统稳定地过度拒答 |

### 2.2 离线损失分解

- 46/66 条轨迹按当前条件已经具备综合条件；
- 41/66 条发生 Synthesizer 输出或服务端校验失败；
- 7/66 条由 Synthesizer 正常选择拒答；
- 8/66 条发生 Collector 结构化失败；
- 8/66 条属于 Collector 或 Gate 证据不足；
- 1/66 条没有持久化 Evidence。

### 2.3 反事实验证

在不重新采集数据、不向 Synthesizer 提供 Gold 的情况下，仅修复综合契约后：

- 技术可交付从 0/17 提升至 15/17；
- 严格正确从 1/15 提升至 3/14；
- 宽松命中从 1/15 提升至 10/14；
- 仍有 2/17 结构失败，4/14 可评分结果根因错误。

这说明 v8 的正确顺序是“契约可靠性 → 证据内容 → 假设精度 → Gate 语义 → 模型对照”。

## 三、v8 产品目标

### 3.1 核心用户结果

每次调查必须交付以下三种结果之一：

1. **明确因果诊断**：指出根因、机制、影响指标、影响分群、反证和建议动作；
2. **有界领先假设**：无法确定唯一根因，但给出排序后的领先假设、支持证据、反证、置信等级和下一项最有价值的数据；
3. **可行动拒答**：客观无法归因，但明确列出已确认事实、已排除方向、缺失信息、负责人和下一步验证方式。

不能再把一句“证据不足”视为完成。

### 3.2 正式目标

| 指标 | v8 正式 Dev 目标 |
| --- | ---: |
| 技术完成率 | ≥97% |
| 业务完成率 | ≥60% |
| 严格根因得分 | ≥50% |
| 宽松根因得分 | ≥70% |
| 关键证据召回 | ≥85% |
| 最终关键证据引用率 | ≥80% |
| 可行动拒答率 | ≥80% |
| Synthesizer 首轮结构成功率 | ≥90% |
| Synthesizer 有界修复后成功率 | ≥97% |
| 工具 ERROR | 0 |
| EMPTY 工具比例 | ≤12% |
| P95 延迟 | ≤45 秒 |
| 三轮终态一致性 | ≥85% |

业务完成率必须同时满足“用户可见结果完整”和“关键事实有证据引用”，不能再用内部轨迹存在证据代替用户交付。

## 四、目标架构

```text
风险事件与调查问题
        ↓
Collector
竞争假设 → 高信息增益工具 → Evidence Assessment
        ↓
Evidence Normalizer
将原始工具结果转换为安全、结构化、可引用事实
        ↓
Evidence Packet v2
事实 + 数值 + 范围 + 来源 + 关系 + 缺口
        ↓
Readiness Evaluator
CAUSAL / BOUNDED / ABSTENTION / NEEDS_COLLECTION
        ↓
Synthesizer
无工具、一次主调用、最多一次定向修复
        ↓
Server Validator
Schema + Hypothesis + Evidence + Grounding + Safety
        ↓
Outcome Projection
明确诊断 / 有界假设 / 可行动拒答
```

架构仍然只有一个 Investigation Agent。Collector 和 Synthesizer 是同一调查运行时中的职责阶段，不是两个自主 Agent，也不拥有独立权限和持久化边界。

## 五、P0 改造一：Evidence Packet v2

### 5.1 当前问题

v7 Evidence 经常只保存“工具返回了当前调查观察”这一类通用 statement。具体数值、版本、模块、分群差异和反馈主题没有稳定传入 Synthesizer，导致模型只能看到证据类别，看不到事实本身。

### 5.2 新数据结构

每条 Evidence 在保留现有审计字段的基础上增加服务端生成的 `factSummary` 和受控 `facts`：

```ts
type EvidenceFact =
  | { kind: "RELEASE"; version: string; platform: string; modules: string[]; flags: string[]; rolloutPercent: number | null; releasedAt: string | null }
  | { kind: "METRIC"; metricKey: string; value: number | null; baseline: number | null; delta: number | null; sampleSize: number | null; window: TimeWindow }
  | { kind: "SEGMENT"; metricKey: string; dimension: string; groups: Array<{ name: string; value: number | null; baseline: number | null; sampleSize: number | null }> }
  | { kind: "FEEDBACK"; themes: Array<{ label: string; count: number | null }>; representativeSamples: string[]; filters: Record<string, string> }
  | { kind: "HISTORICAL"; incidentIds: string[]; similarities: string[]; differences: string[] };
```

Evidence Packet v2 中每条记录至少包含：

- `id`、`category`、`source`、`provenance`、`strength`、`collectedAt`；
- `factSummary`：由服务端基于工具结果确定性生成，不由 LLM自由改写；
- `facts`：白名单字段的结构化值；
- `scope`：时间、平台、版本、地区和用户类型；
- `relations`：对每个候选假设的 SUPPORTS、CONTRADICTS 或 NEUTRAL；
- `limitations`：样本不足、缺基线、范围不完整等数据边界。

### 5.3 安全和边界

- 不传完整工具 transcript；
- 不传案例 ID、Gold、评分规则或目标 Evidence ID；
- 不允许模型创建或补写事实字段；
- 历史事故必须明确标记 `HISTORICAL`，不能单独支撑当前根因；
- 原始 ToolResult 继续持久化，Evidence Packet 只放安全投影；
- 所有数值必须保留来源和工具结果关联，不能由自然语言解析后失去出处。

### 5.4 验收标准

- 22 个 Dev 案例的关键观察值均能从 Packet v2 追溯到 ToolResult；
- Packet 不包含 Gold、评分字段、隐藏 chain-of-thought 或案例身份；
- 相同 ToolResult 生成相同 `factSummary` 和 `facts`；
- 指标、分群、发布和反馈四类 fixture 都有正向与缺失字段测试；
- Evidence Packet 的序列化顺序稳定，可生成内容哈希。

## 六、P0 改造二：Synthesizer 契约可靠性

### 6.1 单一契约源

JSON schema、Prompt 示例、Parser 和服务端 Validator 必须从同一个契约定义派生，避免 Prompt 写一种格式、Parser 接受另一种、Validator 再要求第三种。

至少覆盖：

- `FINALIZE` 的完整字段；
- `STOP_INCONCLUSIVE` 的完整字段；
- `LIMITATION.limitationType`；
- ROOT_CAUSE 必须等于所选 Hypothesis statement；
- 各 Claim 可用的 Evidence 类型；
- disposition 枚举；
- 禁止额外字段和模型自报置信百分比。

### 6.2 有界修复

Synthesizer 最多进行：

- 1 次主调用；
- 1 次结构或 grounding 定向修复；
- 不进行第三次模型重试。

修复输入只包含：

- 原 Evidence Packet；
- 上一次模型输出；
- 服务端 `validationCode`；
- `validationPath`；
- 不超过 500 字的安全错误说明。

禁止在修复信息中包含 Gold、期望根因或评分提示。

### 6.3 服务端确定性补全边界

服务端只能补充不改变业务语义的固定字段，例如缺失的公共流程 `rationale`。不得补充或改写：

- selectedHypothesisId；
- ROOT_CAUSE；
- Evidence ID；
- disposition；
- 指标、分群、机制或行动建议。

### 6.4 可观测性

每次综合记录：

- 主调用是否通过；
- 首个 validation code 与 path；
- 是否触发修复；
- 修复是否成功；
- 最终失败分类；
- 调用次数、tokens 和延迟；
- 不保存私有思维链。

### 6.5 验收标准

- 合法 FINALIZE 与 STOP_INCONCLUSIVE 首轮通过；
- 每个必填字段缺失都有精确错误码和字段路径；
- 修复轮次不会添加 Packet 外 Evidence；
- 结构化失败保留已收集 Evidence；
- 17 案例 smoke 中最终结构成功率 ≥97%。

## 七、P0 改造三：四态 Readiness

### 7.1 状态定义

`READY_FOR_CAUSAL`

- 至少一个 SUPPORTED/CONFIRMED 且 MEDIUM/HIGH 的领先假设；
- 至少一条当前事件 SUPPORTS Evidence；
- 影响证据存在；
- 没有同等强度、未被区分的竞争假设；
- 对 HIGH/CONFIRMED 继续执行更严格的多来源与机制要求。

`READY_FOR_BOUNDED_HYPOTHESIS`

- 有领先方向，但缺少机制、范围或排他性证据；
- 必须输出领先假设、替代假设、支持与反证、缺口；
- 不得表述为确定根因。

`READY_FOR_ABSTENTION`

- 工具空间客观不足、证据相互冲突或异常本身不稳定；
- 必须列出已确认事实、被排除假设、缺失数据和补充方式；
- 合理拒答单独计分，不能算严格根因正确。

`NEEDS_COLLECTION`

- 存在尚未调用、且能明确支持/反驳/区分假设的工具查询；
- 每次继续采集必须说明预期信息增益；
- 没有新增证据时不得重复综合或重复调用同义查询。

### 7.2 实现约束

不扩展 Planner 的顶层决策集合。Readiness 是服务端内部状态：

- CAUSAL 对应 Synthesizer 可返回 FINALIZE；
- BOUNDED 和 ABSTENTION 对应 STOP_INCONCLUSIVE，并由服务端生成结构化 `OutcomeProjection`；
- NEEDS_COLLECTION 返回 Collector 继续规划。

这样可以保留现有 AgentLoop、持久化和审批边界。

## 八、P0 改造四：面向产品经理的 Outcome Projection

### 8.1 明确诊断输出

- 一句话结论；
- 根因与机制；
- 受影响指标与分群；
- 支持证据与反证；
- 置信等级及其来源；
- 推荐处置；
- 风险与限制。

### 8.2 有界假设输出

- 当前领先假设；
- 为什么领先；
- 仍可能的替代假设；
- 哪条证据能区分它们；
- 当前建议：观察、人工升级或暂停决策。

### 8.3 可行动拒答输出

- 已确认事实；
- 已排除方向；
- 当前无法回答的原因；
- 缺少的数据源与查询条件；
- 建议负责人和下一步；
- 在补充数据前不应执行的动作。

Outcome Projection 由服务端基于持久化结果构建，不创建新的 Evidence，也不改变 Investigation 终态。

## 九、P1 改造：Collector 与假设质量

### 9.1 假设模板

每个假设必须包含：

- 发生变化的组件或外部依赖；
- 具体失败机制；
- 受影响的指标或用户对象；
- 预期支持信号；
- 可证伪信号。

禁止只有“发布导致异常”“可能是外部原因”一类不可区分的宽泛假设。

### 9.2 查询策略

工具调用按信息增益排序：

1. 确认发布上下文；
2. 确认异常指标及基线；
3. 查找能区分竞争假设的分群；
4. 用反馈验证用户可见机制；
5. 最后才查询历史相似事故。

每个 CALL_TOOL 必须关联目标假设和 `SUPPORT`、`REFUTE` 或 `DISCRIMINATE` 意图。相同语义签名不能重复执行。

### 9.3 Collector 结构失败修复

Collector 使用与 Synthesizer 相同的“具体错误码 + 字段路径”修复机制，但各自的契约和统计必须分开，避免把收集失败统计成综合失败。

## 十、模型策略

v8 第一阶段继续使用与 v7 相同模型和配置，确保结果变化来自架构，而不是同时更换多个变量。

只有在以下条件全部满足后才做模型对照：

- Evidence Packet v2 完整率通过；
- Synthesizer 最终结构成功率 ≥97%；
- 17 案例严格根因仍低于 35%；
- 失败主要是机制判断错误，而不是证据缺失。

模型对照必须使用完全相同的冻结 Evidence Packet、Prompt、temperature、输出 schema 和评分流程。只比较 Synthesizer，不重新跑 Collector，从而控制成本和变量。

## 十一、评测方案

### 阶段 A：静态与确定性测试

- Packet v2 转换器单元测试；
- schema/parser/validator 一致性测试；
- Gold 泄漏扫描；
- grounding 正反例；
- Outcome Projection 快照测试；
- Provider 空 content、非法 JSON、缺字段和 400/402 错误测试；
- 断点续跑和工件不覆盖测试。

通过条件：全部测试通过，且无凭据或 Gold 进入 Agent 输入。

### 阶段 B：17 案例离线 smoke

优先复用冻结的 v7 工具结果，运行新的 Evidence Normalizer、Readiness 和 Synthesizer。它是开发实验，不计为 v8 正式结果。

进入下一阶段的硬门槛：

- 技术成功率 ≥97%；
- 严格根因 ≥35%；
- 宽松根因 ≥65%；
- 关键证据引用率 ≥80%；
- 无 Gold 泄漏；
- 工具调用为 0，因为使用冻结轨迹。

### 阶段 C：22 案例单轮 smoke

使用完整 v8 Agent 和工具运行一次 22 案例，检查 Collector、Packet、Gate 和 Synthesizer 的端到端行为。

通过条件：

- 恰好 22 条，无删除失败；
- 技术成功率 ≥95%；
- 严格根因 ≥40%；
- 关键证据召回 ≥80%；
- 无系统性错误类别超过 2 次。

### 阶段 D：正式 3×22 Dev 评测

只有阶段 C 通过后，冻结数据集哈希、源码提交、源码内容身份和模型配置，并创建独立 `evaluation/results/v8/`。

正式运行要求：

- 三轮各恰好 22 案例；
- 断点续跑验证数据集哈希、源码身份、模型配置和连续案例前缀；
- 不覆盖 v1–v7；
- 保留所有失败、EMPTY、错误和副作用；
- Provider 402 时保留 partial 并停止；
- 完成后使用独立 v8 盲评目录和新 judge version。

### 阶段 E：Holdout 与人工评审

Dev 达标后才建立不可见 Holdout。Holdout 不能复用已用于调参的案例模板、fixture 或结构指纹。

至少抽取所有 0/1 分结果、所有 N/A、所有行动建议和高置信诊断进行人工评审。没有人工评审前，不称为生产准确率。

## 十二、指标定义修正

### 技术完成率

Provider、Parser、Validator、持久化和终态均成功；业务拒答不算技术失败。

### 业务完成率

满足以下任一条件：

- 正确明确诊断且关键证据引用完整；
- 合理的有界假设，并明确反证与下一步；
- 合理的可行动拒答，并明确缺失信息。

### 关键证据召回

继续衡量内部已找到的关键 Evidence，同时新增“最终引用召回”，防止证据只存在于轨迹而未交付用户。

### 可行动拒答率

在合理 N/A 案例中，输出同时包含已确认事实、缺失数据、下一步查询和风险边界的比例。

### 契约可靠性

分别统计 Collector 和 Synthesizer 的：

- 首轮 schema 成功率；
- 修复触发率；
- 修复成功率；
- 最终结构失败率；
- validation code 分布。

## 十三、实施顺序

### Sprint 1：契约与 Evidence Packet

1. 固化 v8 设计文档和指标口径；
2. 建立共享 schema 定义；
3. 实现 Evidence Normalizer 和 Packet v2；
4. 补齐 Synthesizer 精确修复反馈；
5. 增加契约与泄漏测试。

交付物：代码、单元测试、Packet 样例、validation taxonomy、离线生成器。

### Sprint 2：Readiness 与用户结果

1. 实现四态 readiness；
2. 实现 Outcome Projection；
3. 改进 Collector 假设模板和信息增益策略；
4. 增加可行动拒答指标；
5. 完成 17 案例 smoke。

交付物：smoke summary、review queue、失败分类和产品经理报告。

### Sprint 3：端到端评测

1. 运行 22 案例单轮 smoke；
2. 根据硬门槛决定 GO/NO-GO；
3. 通过后冻结 v8；
4. 运行正式 3×22、盲评、对比报告；
5. 更新 `/benchmark` 数据源。

## 十四、质量门禁

每个代码阶段至少运行：

```bash
npm run tsc
npm run lint
npm test
npm run eval
npm run build
npm run validate:artifact
npm run eval:artifacts:test
git diff --check
```

还必须执行：

- 凭据扫描；
- Agent 输入 Gold/案例身份泄漏扫描；
- `/benchmark` 页面检查；
- v1–v7 工件哈希或只读一致性检查；
- 新增工件数量、案例顺序和失败分母检查。

## 十五、风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 在同一 Dev 集上过拟合 | smoke 只用于研发决策，最终必须建立不可见 Holdout |
| Packet 携带过多原始数据 | 白名单结构化字段、长度限制、敏感字段过滤 |
| 服务端补全偷偷改变答案 | 只允许固定公共字段；根因、证据、动作禁止补全 |
| 四态 Gate 变相放宽 grounding | FINALIZE 继续使用现有严格 Grounded Diagnosis Validator |
| Prompt 越写越长导致成本上升 | 使用 schema 和结构化 Packet，删除重复自然语言说明 |
| 同模型盲评偏差 | 保留同模型结果但标注非独立；正式阶段增加人工抽检 |
| Provider 再次出现协议差异 | preflight 验证 JSON 模式、thinking、空 content 和错误分类 |
| 版本间结果污染 | 独立目录、独立版本号、源码身份和不可覆盖写入 |

## 十六、GO / NO-GO 决策规则

### 允许启动正式 v8 的条件

- 17 案例 smoke 全部硬门槛通过；
- 22 案例单轮 smoke 无系统性结构错误；
- Grounding、安全、审批和历史结果隔离测试通过；
- 源码、数据集、模型配置和评测脚本完成冻结。

### 暂停并重新设计的条件

- Packet v2 后严格根因仍低于 35%；
- 结构成功但错误根因显著增加；
- 为提升成绩必须放宽 grounding 或读取 Gold；
- 关键证据无法由当前工具空间获得；
- 单轮 smoke 已显示系统性失败，不得继续烧 3×22。

### 产品降级定位条件

如果同证据包的多模型对照和工具可观测性改进后，Holdout 严格根因仍无法达到 50%，ReleaseGuard 应正式定位为“发布调查证据工作台”，核心价值改为证据聚合、假设管理、缺口识别和人工决策支持，不再承诺自动根因判断。

## 十七、最终建议

批准 v8 研发，但采用阶段性投资方式：先修契约和 Evidence Packet，再以 17 案例 smoke 验证；未达到门槛就停止，不直接进入正式三轮评测。

v8 的成功不应定义为“更多 FINALIZED”，而应定义为：

**系统能够稳定地把真实已观察事实交付给用户，在证据充分时给出正确且可引用的因果诊断，在证据不足时给出可行动且诚实的调查结果。**

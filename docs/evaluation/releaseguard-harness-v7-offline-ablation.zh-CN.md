# ReleaseGuard Harness v7 离线分阶段消融报告

> 本报告只读取已冻结的 v7 运行轨迹；不读取 Gold，不调用模型或工具，不改变正式评测结果。分类用于定位损失，不是新的业务准确率。

## 汇总

- 覆盖：66 条轨迹（3 轮 × 22 案例）
- 技术终态：1 FINALIZED，65 INCONCLUSIVE
- 按当前 Gate 条件重建后具备综合条件：46（69.7%）
- 证据收集结构化失败：8（12.1%）
- 综合/诊断阶段失败迹象：42（63.6%）
- 完全没有持久化 Evidence：1（1.5%）

## 瓶颈分类

- COLLECTOR_NO_EVIDENCE：1（1.5%）
- COLLECTOR_OR_GATE_EVIDENCE_INSUFFICIENT：8（12.1%）
- COLLECTOR_SCHEMA_FAILURE：8（12.1%）
- NO_TERMINAL_BLOCKER：1（1.5%）
- SYNTHESIZER_EXPLICIT_ABSTENTION：7（10.6%）
- SYNTHESIZER_FAILURE_OR_VALIDATION：41（62.1%）

## 解释与边界

- `SYNTHESIZER_EXPLICIT_ABSTENTION` 表示 Gate 已具备综合条件，Synthesizer 正常返回了拒答；它不同于结构化失败，需要判断拒答是否合理。
- `COLLECTOR_OR_GATE_EVIDENCE_INSUFFICIENT` 表示当前轨迹无法区分是工具没有找到信息，还是 Gate 判断证据不足；不能把它归咎于模型能力。
- `SYNTHESIZER_FAILURE_OR_VALIDATION` 表示综合阶段出现失败迹象；后续应检查输入包和结构化输出，而不是增加无界重试。
- 本报告没有使用 Gold，因此不报告根因准确率，也不把重建的 Gate 条件当作真实标签。

## 下一步决策门

1. 对 `SYNTHESIZER_FAILURE_OR_VALIDATION` 的代表轨迹运行一次无工具 Synthesizer 修复实验，保留相同 Evidence Packet。
2. 若改进后的契约反馈能稳定产生有界、可引用诊断，优先修复 Synthesizer 与服务端校验的接口；若仍失败，再做模型对照。
3. 对其余轨迹按 Collector 证据缺口拆分，只有工具可观测性不足时才扩充工具。
4. 消融通过后先跑小规模 smoke set，再决定是否创建独立 v8。

原始机器可读结果：`evaluation/results/v7/ablation.json`。

# ReleaseGuard AI Harness v7 技术附录

> v7 正式 Dev 三轮评测与同模型盲评的可审计统计。

## 完整性与身份

- 原始运行：3 × 22 = 66；盲评尝试：23；最终覆盖：22 案；失败尝试：1；数值评分：60；N/A：6。
- 三轮数据集、源码、模型配置和连续案例顺序一致；每轮 reportStatus=COMPLETE。
- 技术完成：66/66 (100.0%)；明确诊断：1/66 (1.5%)；同 v3 口径业务完成：22/66 (33.3%)；面向用户交付：1/66 (1.5%)。
- 终态：{"INCONCLUSIVE":65,"FINALIZED":1}；执行错误：{}。

## 根因、证据与拒答

- 严格根因：7/60 (11.7%)；宽松根因：7/60 (11.7%)；均分 0.2333。
- 合理拒答：6/65 (9.2%)；N/A 不计入数值根因分母。
- 引用有效率：5/5 (100.0%)；关键证据召回：68.9%。
- 同时处理支持与反证：44/66 (66.7%)。

## 工具、稳定性、延迟与成本

- 工具非错误完成：154/154 (100.0%)；EMPTY：18/154 (11.7%)；ERROR：0/154 (0.0%)；总调用：154。
- Pass@1：22/22 (100.0%)；三轮全通过：22/22 (100.0%)。
- 终态一致性：21/22 (95.5%)；根因评分一致性：21/22 (95.5%)。
- P50/P95：18.0s / 27.4s；总耗时 0.35h。
- 模型调用 500；工具调用 154；schema repair 34。
- Tokens：input 2,024,720 / output 152,748；峰时估算 $1.0925，非账单。

## 限制与副作用

- The readiness gate can become over-conservative and suppress otherwise useful synthesis.
- The staged path increases model calls and prompt tokens even when tool calls decrease.
- Most runs can be technically successful while still failing to produce a product-useful diagnosis.
- The same visible Dev cases and same-model judge cannot establish production generalization.
- 同数据集持续开发存在调参过拟合风险，必须用 Holdout 验证。

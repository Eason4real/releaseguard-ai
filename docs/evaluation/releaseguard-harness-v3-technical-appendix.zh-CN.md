# ReleaseGuard AI Harness v3 技术附录

> v3 正式 Dev 三轮评测与同模型盲评的可审计统计。

## 完整性

- 原始运行：3 × 22 = 66；盲评请求：22；数值评分：66；N/A：0；盲评错误：0。
- 技术完成：62/66 (93.9%)；业务完成：31/66 (47.0%)。
- 终态：{"INCONCLUSIVE":18,"FINALIZED":44,"FAILED":4}；执行错误：{"PROVIDER_MALFORMED_RESPONSE":3,"PROVIDER_FAILURE":1}。

## 工具与证据

- 工具非错误完成：204/204 (100.0%)；EMPTY：35/204 (17.2%)；总调用：204。
- 引用有效率：201/201 (100.0%)；关键证据召回：75.3%。
- 同时处理支持与反证：55/66 (83.3%)。

## 稳定性、延迟与成本

- Pass@1：21/22 (95.5%)；三轮全通过：19/22 (86.4%)。
- 终态一致性：12/22 (54.5%)；根因评分一致性：9/22 (40.9%)。
- P50/P95：154.0s / 299.4s；总耗时 2.92h。
- 模型调用 606；工具调用 204；schema repair 97。
- Tokens：input 2,794,449 / output 1,167,570；峰时估算 $2.7708，非账单。

## 限制与副作用

- Richer capability metadata increases prompt size and depends on production schema/catalog parity.
- More conservative evidence gates can increase INCONCLUSIVE outcomes when fixtures lack discriminating observations.
- AgentLoop, approval, grounding, and external-write boundaries were not relaxed.
- 同数据集持续开发存在调参过拟合风险，必须用 Holdout 验证。

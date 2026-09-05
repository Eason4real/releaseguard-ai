# ReleaseGuard Harness v4 不完整技术实验报告

## 结论

v4 不能作为正式业务效果对比。仅第 2、3 轮各 22 个案例完整落盘，第 1 轮缺失，因此没有执行盲评，也不生成 66 次正式指标。

## 已观察故障

- 第 2 轮 22 次中：6 次 FINALIZED、2 次 INCONCLUSIVE、14 次技术失败。
- 技术失败集中为 `PROVIDER_MALFORMED_RESPONSE / INVALID_JSON`。
- 多数失败发生在模型返回空 `content` 后；运行时进行了两次 schema repair，仍为空并终止。
- 进度日志显示的 `model=0` 与 checkpoint 不一致；实际失败案例包含 4–17 次模型调用。这是日志投影问题，不代表未调用模型。

## 根因

1. v4 策略分支没有继承 v3 已验证的工具能力和 EMPTY 处理 Prompt，属于版本组合错误。
2. 空响应后的 repair 仍启用高强度 thinking，有限的 5000 token 输出预算可能继续被推理内容消耗，无法稳定产生 JSON `content`。
3. v4 评测期间新增了非运行时汇总脚本，导致仓库内容哈希漂移；即使运行时代码未变，也不满足正式可复现身份要求。

## 处置

- 永久保留 v4 第 2、3 轮原始结果，不删除失败案例。
- v4 标记为 `INCOMPLETE_TECHNICAL_EXPERIMENT`，不宣称业务指标。
- 不补拼第 1 轮，不执行 v4 盲评。
- v5 恢复 v3 策略继承，并在空 JSON repair 时关闭 thinking；完成测试后重新冻结独立源码身份。

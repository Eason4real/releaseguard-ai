# ReleaseGuard Harness v5 早停诊断报告

v5 在第 1 轮完成 4 个案例后主动停止，4 个案例均复现空 `content` 导致的 `INVALID_JSON`。结果仅用于技术诊断，不进行业务评分或盲评。

最小化 provider 协议探针确认：省略 `thinking` 字段时，`deepseek-v4-flash` 仍返回 `reasoning_content`；显式发送 `thinking: {"type":"disabled"}` 后才不再生成 reasoning 内容。v5 repair 仅省略字段，因此没有真正关闭 thinking。

v6 将在空 JSON 的 repair 请求中显式关闭 thinking，同时保留原始失败、grounding、审批和数据隔离边界。

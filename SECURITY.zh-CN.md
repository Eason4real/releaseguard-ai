# Security Policy

[English](SECURITY.md) | 简体中文

## Supported version

安全修复以 `main` 分支当前版本为准。该项目仍处于早期阶段，暂不承诺维护历史版本。

## Reporting a vulnerability

请不要通过公开 Issue 提交以下内容：

- API Key、GitHub Token、Cookie或其他凭证；
- 可以访问私有系统的URL或日志；
- 可用于绕过审批、权限或外部写操作边界的完整利用细节。

请通过仓库所有者GitHub个人资料中的公开联系方式私下报告，并提供：

1. 受影响的版本或Commit；
2. 复现步骤；
3. 可能造成的影响；
4. 建议的缓解方式（如有）。

## Security boundaries

- `PUBLIC_DEMO` 不接受凭证，并禁用共享数据、真实模型与外部写接口。
- `PRIVATE_LIVE` 只适用于受控、访问受限的单一操作者环境。
- 外部写操作必须通过服务端验证，并绑定到一次具体审批及冻结参数。
- 相似历史事故不能替代当前事故证据。
- 本仓库不会要求贡献者把真实密钥提交到源码或Issue。

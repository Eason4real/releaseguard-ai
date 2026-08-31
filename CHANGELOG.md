# Changelog

English | [简体中文](CHANGELOG.zh-CN.md)

This project follows the structure of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). ReleaseGuard AI is at an early public stage; version numbers are not production-readiness guarantees.

## [Unreleased]

### Added

- GitHub Actions continuous integration covering type checking, linting, build verification, tests, and deterministic evaluation.
- Public-facing README, documentation navigation, evaluation methodology, contribution guidance, security policy, and roadmap.
- MIT License.

### Changed

- Reframed public documentation from portfolio language toward users and developers.
- Clarified the boundaries among public replay, Live Agent execution, and local/CI fallback modes.
- Added a complete English README alongside the Chinese-default repository homepage, while keeping contributor, security, evaluation, and technical documentation English-first.

## [0.1.0] - 2026-08-02

### Added

- Deterministic risk detection, risk events, and the investigation runtime.
- Structured Planners, a controlled Agent Loop, and atomic investigation tools.
- Competing hypotheses, supporting and contradicting evidence, and structured diagnosis.
- Human approval, frozen arguments, and replay protection for `CREATE_GITHUB_ISSUE`.
- Public replay experience, three-minute guide, and full best-practice walkthrough.
- Hybrid historical-incident retrieval, a 22-case investigation benchmark, and regression tests.

[Unreleased]: https://github.com/Eason4real/releaseguard-ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Eason4real/releaseguard-ai/releases/tag/v0.1.0

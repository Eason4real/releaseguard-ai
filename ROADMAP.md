# ReleaseGuard AI Roadmap

English | [简体中文](ROADMAP.zh-CN.md)

This roadmap describes product priorities, not completed capabilities or delivery commitments. The implementation, automated tests, and main README remain the source of truth for current behavior.

## Now: Evaluation credibility and public reproducibility

- Freeze the public incident-reconstruction dataset and scoring rules.
- Publish comparable Direct LLM, current Agent, and improved Agent results under the same input conditions.
- Preserve per-case raw outputs, scoring rationale, run parameters, and error slices.
- Add repeated-run stability, token, cost, and end-to-end latency reporting.
- Make answer-leakage checks and the human-review queue explicit.

## Next: Investigation quality and observability

- Improve Planner constraints, evidence sufficiency, and tool-argument validation using frequent benchmark failure modes.
- Strengthen no-information-gain detection, failure recovery, and contradicting-evidence checks.
- Provide shareable investigation traces and versioned evaluation reports.
- Expand public cases across industries and failure types while keeping gold labels auditable.

## Later: Controlled integrations

- Evaluate additional read-only business data sources after defining an explicit permission model.
- Evaluate approval-protected Jira or Linear actions only after real demand and security review.
- Research multi-user access, tenant isolation, and enterprise authentication without exposing Live capabilities before access control exists.

## Explicitly outside the current scope

- automatic rollback or production remediation without approval;
- replacing deterministic anomaly detection with an LLM;
- introducing Multi-Agent orchestration merely to demonstrate complexity;
- presenting public or synthetic cases as private enterprise production data.

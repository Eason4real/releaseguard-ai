# Contributing to ReleaseGuard AI

English | [简体中文](CONTRIBUTING.zh-CN.md)

Thank you for your interest in ReleaseGuard AI. The project welcomes reproducible bug reports, public incident cases, evaluation improvements, and focused engineering contributions.

## Before opening an issue

- Search existing issues to avoid duplicates.
- For product or evaluation problems, describe the expected behavior, actual behavior, and reproduction steps.
- For incident cases, provide public sources, the investigation inputs, the evidence for the final root cause, and any potential answer-leakage risk.
- Never submit API keys, tokens, cookies, private logs, customer data, or other sensitive information.

## Local development

```bash
npm ci
cp .env.example .env
npm run dev
```

The default environment uses `PUBLIC_DEMO` or the deterministic local fallback. Do not connect to production D1 or real external systems unless you have explicit authorization.

## Change requirements

1. Preserve the single Investigation Agent, structured state, atomic tools, and human-approval boundary.
2. Never treat LLM output as authoritative for permissions, approval, or state transitions.
3. Do not persist hidden chain-of-thought. Persist only public rationale, hypotheses, observations, and evidence references.
4. Do not hard-code `case_id`, incident names, or gold labels to pass a benchmark.
5. Add focused regression coverage for behavioral changes.
6. Keep public fixtures, offline simulations, and production data clearly separated.

## Documentation translations

English documentation is the source of truth. When a change affects documented behavior, update the corresponding Simplified Chinese file in the same pull request when one exists. Translation changes must preserve capability claims, limitations, commands, links, and security boundaries.

## Verification before submission

```bash
npm run tsc
npm run lint
npm test
npm run eval
npm run eval:investigation-dev-harness
```

Live LLM evaluation depends on external credentials and is not a required check for an ordinary pull request. If you run it, record the model, parameters, commit, and raw-result location in the pull request without exposing credentials.

## Pull requests

- Use a concise, specific title.
- Explain the problem, approach, risks, and verification results.
- Keep each pull request focused on one coherent change.
- Do not commit `.env` files, credentials, `node_modules`, build output, databases, runtime logs, or caches.

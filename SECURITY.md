# Security Policy

English | [简体中文](SECURITY.zh-CN.md)

## Supported version

Security fixes target the current version of the `main` branch. The project is still at an early stage and does not currently commit to maintaining historical versions.

## Reporting a vulnerability

Do not submit the following through a public GitHub issue:

- API keys, GitHub tokens, cookies, or other credentials;
- URLs or logs that provide access to private systems;
- complete exploit details that could bypass approval, authorization, or external-write boundaries.

Report vulnerabilities privately through the public contact information on the repository owner's GitHub profile. Include:

1. the affected version or commit;
2. reproduction steps;
3. the potential impact;
4. suggested mitigation, if available.

## Security boundaries

- `PUBLIC_DEMO` accepts no credentials and disables shared data, real models, and external-write APIs.
- `PRIVATE_LIVE` is intended only for one trusted operator in a controlled, access-restricted environment.
- External writes require server-side validation and approval bound to one exact frozen argument set.
- A similar historical incident cannot replace evidence from the current incident.
- This repository will never ask contributors to commit real credentials to source code or public issues.

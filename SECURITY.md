# Security policy

## Supported versions

Security fixes target the latest published 0.4.x version. Older pre-public prototypes are not supported distribution channels. This is early-stage software; the project does not promise an enterprise response SLA.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/yoyooyooo/lcu-auto/security/advisories/new). Do not open a public issue containing credentials, a working exploit against a live desktop, private screenshots, or a real remote endpoint.

Describe the affected version, trust boundary, minimal reproduction using synthetic data, and possible impact. Maintainers will review reports as availability allows, coordinate a fix and disclosure where feasible, and avoid asking you to reveal secrets. No fixed response time is promised.

## Scope

This project handles local automatic consent, MCP lifecycle, credential files and HTTP authentication. It does not implement LCU's desktop engine or the official ChatGPT application. Report upstream-specific defects to their owners as well, without publishing their proprietary files.

Understand the [security model](docs/security-model.md) before deploying. Automatic native-app consent intentionally gives a trusted client meaningful control of your desktop. Use narrow network access, a protected identity provider and a non-sensitive test task first.

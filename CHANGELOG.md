# Changelog

## 0.4.2

- Verify that the GitHub Actions trusted-publishing path can publish the public package with signed provenance; no desktop-control API changes.
- Document the registry-installed consumer check and the public release evidence for the initial `0.4.1` bootstrap.

## 0.4.1

- First npm registry release, including the previously published source-only 0.4.0 candidate.
- Explicit `js_reset` replaces the owned LCU runtime process, including a broken runtime retained across HTTP reconnects. It also refreshes the runtime after a desktop-app reinstall.
- Reset waits for confirmed teardown before replacement, never replays an uncertain action, and keeps failed teardown fail-closed. A failed replacement can be retried by another explicit reset.
- Document the distinction between transport reconnection, runtime reset and operating-system permission grants.

## 0.4.0

First public source candidate, replacing a machine-specific prototype. This version was not published to npm.

- Stable Effect 4.1.0, Effect CLI, Effect filesystem/process/HTTP services and a Node.js distribution.
- `mcp` for stdio, optional `mcp --url` for a shared broker, and `serve` for HTTP; legacy command aliases remain available.
- Platform-aware configuration paths and opt-in user-service definitions for launchd, systemd and Task Scheduler.
- Persistent authenticated conversation contexts for short-lived remote MCP clients, with separate discovery and execution limits.
- Hermetic protocol, CLI, path and service-definition tests, plus explicit live-desktop verification.
- Public documentation, security/contribution policies and tag-driven release automation.

Desktop execution remains subject to upstream LCU's platform support and installed application requirements. See [compatibility](docs/compatibility.md).

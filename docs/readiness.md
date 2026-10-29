# Public-release verification

This record separates implementation, automated checks, live desktop behavior and publication. It is not a claim that every upstream platform is supported.

## Release gates

| Area                   | Gate                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and license   | Public package manifest, MIT license, upstream attribution and explicit proprietary-runtime boundary.                                    |
| Public documentation   | English and Chinese entrypoints, one centered title each, working relative links/anchors, prerequisite and risk statements.              |
| Portability            | Platform-path and service-definition tests; CI matrix for CLI, protocol and packed installation on macOS/Linux/Windows.                  |
| Protocol and lifecycle | Hermetic real-SDK tests for stdio, authenticated HTTP, short-lived clients, context isolation, cancellation and cleanup.                 |
| Distribution           | Built Node.js output, allowlisted tarball, dependency-spec check, clean npm install and executable-bin smoke.                            |
| Security               | JWT validation, private local credentials, verified-owner context binding, body/connection limits, no hidden retries or telemetry.       |
| Release automation     | Immutable exact-version tag, audited public artifact, official-registry integrity readback, OIDC/provenance for subsequent CI publishes. |

`bun run check` runs the source gates. `bun run pack:check` verifies the actual tarball and installs it into a fresh consumer directory. GitHub workflow results are the authority for the configured OS matrix; a locally generated service definition is not a live Windows/Linux installation test.

## Live verification boundary

The development baseline has exercised the real LCU 0.11.4 shared client on Apple Silicon macOS. Previous end-to-end checks included multiple independent MCP calls, Unicode paste, saved-file byte comparison, returned screenshots, reset and cleanup. Actual ChatGPT short-lived tool clients have retained one logical runtime across more than eight calls.

The 0.4.0 candidate passed 36 local automated tests and 261 assertions, Node build, 64 documentation links/anchors, and a clean consumer installation of the actual tarball. Its built Node entrypoint also passed a seven-call native fixture test with independent saved-byte comparison, screenshot return and reset. npm registry publication remains deferred; the tarball-install result is not a registry-release claim. The macOS background broker was replaced with a Node process running the built entrypoint; a second seven-call native test through its authenticated HTTP bridge passed. The GitHub matrix is verified separately. Operator-specific traces, credentials, private domains, screenshots and old private Git history remain outside this public repository.

## Not claimed

Linux desktop execution, Windows desktop-engine support, non-macOS service installation, sleep/reboot recovery and extended multi-agent operation are not established by the hermetic suite. A successful npm publish does not prove OAuth login/refresh for every client or network.

Production and development dependency audits are reviewed separately. High-severity findings must be resolved or explicitly documented before release; a successful install is not a security audit.

[Compatibility](compatibility.md) · [Release operations](releases.md) · [Contributing](../CONTRIBUTING.md)

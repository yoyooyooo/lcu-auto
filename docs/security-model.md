# Security model

## Trust what you connect

This service can read windows, capture screenshots and send input as your OS user. Automatic app consent is a deliberate product capability, not a sandbox. Connect only trusted clients and protect their accounts. A remote account compromise may become access to the logged-in desktop.

The default maximum consent scope is `always`: when the original Runtime offers persistent approval, it may record that grant for reuse by other clients under the same OS account. `session` and `once` reduce new approval persistence. None of these settings revoke existing approvals; use upstream's documented approval management.

Only recognized native-app requests are automatically answered. Unknown requests are cancelled. The upstream host-app guard is retained; a parent environment that enables its testing bypass causes startup to fail. OS screen-recording, Accessibility and other required permissions remain OS-owned. The model cannot call internal approval-management or lifecycle tools through this server.

## HTTP and OAuth

The listener binds to `127.0.0.1`. A local caller presents an owner-private bearer token at a loopback Host. Public-host requests require a Cloudflare Access application JWT: signature, issuer, audience, expiry, issued-at and application type are validated. An unsigned email header is not identity. A JWKS outage returns a retryable service failure, not a false invalid-login response.

This boundary assumes the local OS account and authenticated reverse proxy are trusted. Any process running as the same local user may read their token; an attacker already controlling that account is outside this boundary. Do not expose the loopback port directly through a proxy that rewrites Host into a trusted local identity without providing the configured Access assertion.

Host/Origin validation and a bounded request body reduce DNS-rebinding and malformed-input exposure. MCP session IDs and conversation correlation identifiers are not secrets that can replace authentication. Every context is namespaced under the verified principal.

## Data and logs

Tool results, accessibility text and screenshot images go to the connected client and its model provider. They can contain sensitive data. Runtime instructions and schemas are read from the selected installed LCU release; tool execution may access whatever that Runtime permits.

This package sends no telemetry. It does not persist tool code, screenshots or result bodies in production logs. Logs record timing, tool names, outcome categories and hashed context identifiers. Native-app approval events include the app identifier and selected scope. Local credentials and service manifests remain on the machine; log files should use user-private permissions.

Expected outbound traffic includes the remote MCP connection from your client, Cloudflare JWKS retrieval when Access is configured, and traffic caused by the user's chosen apps. Upstream LCU and the desktop app may have separate update/network behavior; this project does not audit those as its own telemetry.

## Cancellation and recovery

No desktop action is automatically retried. An error, timeout or lost response may occur after a side effect. Observe the current state before deciding whether to try again. Do not use multi-client concurrency to perform overlapping tasks in the same window.

The [private reporting policy](../SECURITY.md) describes how to report vulnerabilities without posting tokens or desktop data publicly.

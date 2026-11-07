# Architecture

The caller's interface is small: `mcp` provides two tools, `serve` hosts the shared broker, and `mcp --url` connects a local stdio client to that broker. Framework types stay at the boundaries.

## Ownership

`cli.ts` uses Effect CLI for parsing, help and command composition. Effect Scope owns long-lived listeners and connections; NodeRuntime owns process signals. `paths.ts` defines deterministic platform-path policy. `credentials.ts` and `service.ts` use Effect filesystem, HTTP-client and process services.

`lcu.ts` loads the shared client from a resolved, trusted LCU installation, validates its public surface and answers recognized native-app consent. It does not copy or patch the desktop engine. `policy.ts` owns consent-scope selection and the child-environment allowlist. jose verifies JWTs; replacing it with handwritten cryptography would not improve the boundary.

`web-server.ts` serves Web Requests through Effect's Node HTTP server. `http.ts` owns protocol routing, authentication binding, transport admission and schema discovery. The official MCP SDK still owns JSON-RPC and transport semantics.

`contexts.ts` owns bounded execution contexts; `session.ts` owns a runtime, REPL, stable control turn and cleanup. The desktop queue serializes actions and lifecycle finalizers. `connect.ts` owns a local client's stdio/HTTP bridge and heartbeat.

## Transport is not execution state

A tool-discovery handshake should not allocate a persistent computer-control worker. The broker obtains the upstream schemas through one temporary probe, closes it and caches the public surface. Actual runtime allocation happens on the first tool call.

For clients that send `X-OpenAI-Session` or `openai/session`, state is keyed by a digest of verified principal, context kind and the opaque conversation value. Conflicting or malformed correlation identifiers are rejected. Correlation never replaces authentication. Short-lived HTTP clients reuse the logical context; closing one such transport does not destroy the conversation's REPL.

Ordinary stateful MCP clients receive transport IDs, each bound to an authenticated principal and a connection-owned execution context. Local bridges keep their transports alive with periodic ping. These pings no longer extend the lifetime of an execution context. Contexts and lightweight transports have separate limits and expiry; in-flight work is never evicted.

Some ChatGPT scheduled/background runs create a fresh transport for each `js` call without a recognized conversation correlation identifier. In that case each transport owns a different runtime, so REPL variables do not survive between calls; this happens even without capacity reclamation. The broker cannot infer a task identity or share an authenticated user's REPL across unrelated transports. Server instructions therefore tell uncorrelated callers to reacquire targets and observe current UI during each call, while leaving the upstream LCU API and execution semantics unchanged.

Under execution-context capacity pressure, the broker may close the least recently used idle **transport-owned execution** of the same authenticated principal. The healthy transport is retained. The client must explicitly call `js_reset` before using `js` again. The broker does not infer a ChatGPT task identity, evict a correlated conversation context, interrupt an in-flight operation or replay an action. Normal idle expiration remains the default cleanup path when capacity is available.
If upstream teardown fails, its execution slot remains reserved rather than allowing overlapping runtimes with unconfirmed cleanup.
The temporary discovery probe has the same ownership rule. A failed probe close prevents further discovery attempts from spawning unchecked upstream processes until the Broker is restarted. Its quarantine count appears separately in health diagnostics.

Each transport records whether it has already attempted a tool call. A newly initialized stateful transport may issue its first `js` directly; if its execution context later expires, the same transport's next `js` fails with `LCU_CONTEXT_RESET_REQUIRED` and has no desktop side effects. Its `js_reset` starts exactly one fresh generation. For `X-OpenAI-Session` or `openai/session` clients, the broker cannot distinguish a first call from an expired logical context without retaining unbounded histories, so `js` without an existing context requires an explicit `js_reset` even on first use. Clients must acquire their app again after reset. A new transport ID after reconnecting is a new identity; no claim of cross-transport replay detection is made without stable correlation.

Transport liveness uses its own idle clock. Execution expiration uses time since the **last completed accepted tool call**, not time since the last ping or tool discovery. The HTTP broker leaves healthy idle transports connected, while closing the actual owned LCU runtime after 10 minutes of execution inactivity. This releases the expensive context slot without forcing Pi or OMP to reconnect.

## Control-turn lifetime

Successful calls retain the live control turn. Ending it after every observation would make a later input call inactive even if its JavaScript variable still exists. Returned tool errors leave state available for inspection; cancellation or transport failure ends the control turn. Cleanup failure disables further actions rather than retrying a possibly executed action.

An explicit `js_reset` is still accepted for a broken execution context. Under the same desktop queue, it attempts turn finalization, waits for confirmed closure of the owned upstream process, and creates a fresh runtime and session identity. This refreshes runtime state after an application reinstall as well as clearing REPL bindings. A failed turn notification does not block replacement when process closure succeeds; a failed process closure does. The closure promise, including rejection, is retained so a second idempotent close cannot disguise failed teardown. No previous action is replayed, and the next input requires a fresh observation. Shutdown and cancellation fence replacement, and a failed new connection is itself retired before a later explicit reset can retry.

For idle retirement, a failed turn notification with a **confirmed process close** is audited but does not retain an otherwise dead execution slot. An unconfirmed process close still quarantines the slot. The HTTP listener is closed even when another cleanup reports an error; shutdown itself reports the unresolved cleanup.

Finalizers participate in the same desktop queue and cannot be rejected by ordinary admission limits. Shutdown stops new work, interrupts pending operations and closes owned resources. A successful request does not imply exactly-once execution after network failure.

## Alternatives not taken

A deep LCU fork would couple local policy to upstream maintenance. A generic stdio/HTTP pipe would still leave approval and control lifetime to an incompatible client. One runtime per HTTP connection breaks short-lived clients; one runtime for all users would mix state and identity. The current adapter isolates logical owners without inventing a backend plugin framework.

A fully Effect-native replacement of the MCP wire implementation is not needed: the SDK is already the protocol owner. Effect owns execution, resources and platform services around it. Pure transformations remain ordinary TypeScript.

[Security model](security-model.md) · [Remote deployment](deployment.md)

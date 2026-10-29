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

Ordinary stateful MCP clients receive transport IDs, each bound to an authenticated principal and a connection-owned execution context. Local bridges keep these alive with a periodic ping. Contexts and lightweight transports have separate limits and expiry. In-flight work is not evicted to admit another context.

## Control-turn lifetime

Successful calls retain the live control turn. Ending it after every observation would make a later input call inactive even if its JavaScript variable still exists. Returned tool errors leave state available for inspection; cancellation or transport failure ends the control turn. Cleanup failure disables further actions rather than retrying a possibly executed action.

An explicit `js_reset` is still accepted for a broken execution context. Under the same desktop queue, it attempts turn finalization, waits for confirmed closure of the owned upstream process, and creates a fresh runtime and session identity. This refreshes runtime state after an application reinstall as well as clearing REPL bindings. A failed turn notification does not block replacement when process closure succeeds; a failed process closure does. The closure promise, including rejection, is retained so a second idempotent close cannot disguise failed teardown. No previous action is replayed, and the next input requires a fresh observation. Shutdown and cancellation fence replacement, and a failed new connection is itself retired before a later explicit reset can retry.

Finalizers participate in the same desktop queue and cannot be rejected by ordinary admission limits. Shutdown stops new work, interrupts pending operations and closes owned resources. A successful request does not imply exactly-once execution after network failure.

## Alternatives not taken

A deep LCU fork would couple local policy to upstream maintenance. A generic stdio/HTTP pipe would still leave approval and control lifetime to an incompatible client. One runtime per HTTP connection breaks short-lived clients; one runtime for all users would mix state and identity. The current adapter isolates logical owners without inventing a backend plugin framework.

A fully Effect-native replacement of the MCP wire implementation is not needed: the SDK is already the protocol owner. Effect owns execution, resources and platform services around it. Pure transformations remain ordinary TypeScript.

[Security model](security-model.md) · [Remote deployment](deployment.md)

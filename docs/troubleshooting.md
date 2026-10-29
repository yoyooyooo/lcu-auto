# Troubleshooting

## CLI starts, but LCU is missing

Run `lcu-auto doctor --json` and inspect `lcu-auto config paths`. Install upstream LCU first, or pass `--lcu-dir` to its installation prefix/release directory. `--lcu-command` changes the executable only; the compatible shared adapter must still be available.

CLI portability does not imply an installed desktop backend. Follow the [platform boundary](compatibility.md), especially on Windows, Intel Mac, Wayland or headless hosts.

## Computer Use is not active

Observe the target through the documented `cua.getApp(...)` or `app.getAXState()` before input after a cancellation/reset. Do not search for an extra `get_app_state` MCP tool: that is an upstream internal name.

A normal successful call should not invalidate the next call's app binding. If it does, report the client type and sanitized lifecycle metadata. Do not attach private window text or screenshots to a public issue.

## Too many contexts or lost bindings

Discovery and HTTP transports have different limits from execution contexts. Repeated ChatGPT connections in one conversation should share one context. If a client sends inconsistent conversation IDs, the broker rejects the mismatch instead of mixing state.

Idle contexts are reclaimed after ten minutes. Local stdio bridges keep their broker connection alive. Stop unused clients or reset the task; raising limits without understanding ownership can hide a leak.

## Session is closed, even after reconnecting or reinstalling the desktop app

An HTTP reconnect preserves the logical conversation; it does not restart the broker or repair a broken execution context. Reinstalling ChatGPT.app also does not restart an already-running LCU server. A health response of `ok: true` only confirms that the broker is reachable, not that its desktop worker or system permissions are ready.

On 0.4.1 or later, explicitly call the MCP `js_reset` tool. It closes and replaces that context's owned LCU runtime without replaying any previous action. JavaScript bindings are discarded; select and observe the target again before input. If old-process teardown cannot be confirmed, reset remains fail-closed and reports the error rather than overlapping runtimes.

For a pre-0.4.1 broker, rebuild/update first and restart the user service. `lcu-auto service restart --force-disconnect` disconnects all contexts on that broker; use it only when accepting that interruption. There is no need to recreate OAuth credentials just to repair an execution context.

Reset and restart do not grant Accessibility or Screen Recording permissions. When intentionally reauthorizing a reinstalled app, make one harmless observation request, finish the native permission flow locally, then explicitly reset and observe again if the earlier call timed out. Do not keep replaying UI actions while permission readiness is unknown.

## Token file rejected

Use `lcu-auto token` to create a new file; it refuses overwrite. Unix files must be owned by your user and not accessible to group/others. Symlinks are rejected. On Windows, restrict the file's ACL to your account. Do not print the token to diagnose it.

## OAuth 401 versus service 503

401 means credentials are missing/invalid or the edge rejects authentication. 503 can mean the signing-key service is temporarily unreachable. A temporary 503 is not a reason to reauthorize or loosen the policy. Check Access configuration, audience, preserved Host and network reachability without logging JWTs.

## Input succeeded but text is wrong

The current live macOS baseline showed `typeText` dropping some non-ASCII text in one test app. Prefer the upstream native `app.paste` for Unicode/multiline content and verify the resulting UI or saved file. The adapter does not rewrite user code or retry inputs automatically.

## Service cannot start or stop

Use `service status`, then the native manager logs. Ensure the port is free and the installed Node/CLI/config paths still exist. A GUI login may not inherit your shell environment. Stop/restart refuses active or unreadable sessions unless `--force-disconnect` is explicit.

Do not start a second standalone runtime as a workaround while another agent is controlling the same window. Observe the desktop after a crash or timeout before replaying any possible side effect.

[Private security reports](../SECURITY.md) · [Bug reports](https://github.com/yoyooyooo/lcu-auto/issues)

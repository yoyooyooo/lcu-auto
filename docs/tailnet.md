# Tailnet-only HTTP MCP using Tailscale Serve

This optional route lets trusted machines connect to one machine's existing `lcu-auto serve` broker by HTTPS Streamable HTTP MCP. Normal MCP calls do not require SSH. The desktop runtime, shared queue and Cloudflare Access path remain unchanged.

## Prerequisites

- The destination host has a working LCU runtime, an authenticated loopback broker and Tailscale Serve.
- Both hosts are authorized members of the same Tailnet. Prefer narrow ACL/grant rules for the source device and Serve port.
- Choose a free **tailnet-only** HTTPS Serve port, not a public Funnel port.
- The MCP client supports Streamable HTTP and custom `Authorization` headers. `lcu-auto mcp --url` deliberately remains loopback-only.

## Create a stable remote credential

```sh
lcu-auto token --token-file ~/.config/lcu-auto/remote.token
```

The command writes 32 cryptographically random bytes (64 hex characters), never prints or overwrites the credential, and uses owner-only file permissions (`0600` on Unix). Keep it separate from `http.token`. Store a recoverable master copy in a trusted secrets manager and provision a private local file for the broker. A restart always reuses that file; it never silently rotates it. To rotate, update the secrets manager and clients, atomically replace the file, and restart the broker.

`--remote-token-file PATH` overrides the default file path; `LCU_AUTO_REMOTE_TOKEN_FILE` changes the default. A manually supervised foreground `serve` also accepts `LCU_AUTO_REMOTE_TOKEN` in its environment if no file override is specified, but inherited environments are more exposure-prone. `service install` deliberately stores only the file path in its service definition.

## Run the broker and proxy

```sh
# Destination: the existing loopback broker (or its service definition)
lcu-auto serve --tailnet-origin https://mini.example-tailnet.ts.net:9443 \
  --remote-token-file ~/.config/lcu-auto/remote.token

# Destination: separate terminal, after inspecting existing Serve routes
tailscale serve --bg --https=9443 8789
tailscale serve status
```

For a managed broker service, stop the existing service after checking its client state, then reinstall its definition with `--tailnet-origin ... --remote-token-file ...` **plus existing** `--access-config ...` if Cloudflare Access is already configured. Start it and confirm `lcu-auto service status`. `stop` refuses to disconnect active clients without explicit authorization. See [services](services.md).

The broker continues binding `127.0.0.1:8789`. Tailscale Serve terminates HTTPS and forwards to loopback, preserving the configured Tailnet Host. The broker checks the remote bearer at this Host only; the local bearer cannot authenticate there, and the remote bearer cannot authenticate at a Cloudflare public Host. If a proxy changes the Host, fix its proxy configuration rather than bypassing authentication. A Host check by itself does **not** cryptographically attest Tailscale network origin: tailnet isolation and authenticated TLS remain prerequisites.

## Connect and verify

Configure the client with `https://mini.example-tailnet.ts.net:9443/mcp` and a secret-sourced header `Authorization: Bearer <remote-token>`. This is an HTTP MCP endpoint; there is no SSH process to maintain. Check that an unauthenticated request gets `401`, an authorized health request gets `200`, and `initialize` and `tools/list` return `js` and `js_reset`. Finish with a harmless UI observation before trying desktop input. Local and Cloudflare endpoints must keep rejecting the remote bearer.

Remote clients retain their HTTP transport even after the desktop execution context expires. The next `js` for that retained context returns `LCU_CONTEXT_RESET_REQUIRED` without running code. Call `js_reset`, reacquire the target app and observe it before input. A client sending `X-OpenAI-Session` or `openai/session` also needs an initial `js_reset` for a missing context; simply reconnecting is not an implicit reset. Heartbeat requests maintain only the transport, not the JavaScript runtime.

## Security notes

- A holder of the remote credential can operate the logged-in desktop with existing LCU permissions; this is not a per-app sandbox.
- Restrict Tailscale Serve access using tailnet policy. **Never** make this MCP endpoint public through `tailscale funnel`.
- The broker does not infer an authorized identity from spoofable forwarded headers or Tailscale tags. Tailnet ACL and bearer authentication are separate checks.
- Clients should retrieve the bearer from a secrets manager or a protected local configuration file, not a committed repository or command argument.
- A lost response may follow an already-executed desktop action. Observe state before retrying, never blindly replay side effects.

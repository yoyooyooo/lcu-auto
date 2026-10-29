# Remote deployment with Cloudflare

This guide assumes you control the desktop, a Cloudflare account and a hostname. It does not assume the maintainer's account or domain. The CLI never reads a Cloudflare administration token and does not create cloud resources automatically.

## Keep a local path working

Install upstream LCU, run `lcu-auto doctor`, then create the broker credential with `lcu-auto token`. Confirm a local client can use `lcu-auto mcp --url http://127.0.0.1:8789/mcp` while `lcu-auto serve` is running.

Local credentials stay local. Do not paste them into ChatGPT, public URLs, repository secrets or shell history.

## Protect a dedicated hostname

Create a dedicated Access self-hosted application for your hostname, for example `desktop.example.com`, using a restrictive identity policy. Enable **Managed OAuth** and dynamic client registration for the callback URLs required by your MCP client. Do not substitute an `Everyone` or bypass policy to make login convenient.

Use the client's current official callback documentation. ChatGPT and other platforms can change callback formats; allow only the necessary origins/paths, not arbitrary public redirects. For local CLI OAuth clients, explicitly permit their loopback callback when required.

Cloudflare's official [Managed OAuth documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) explains metadata, login and origin verification. A browser-only Access login page is not equivalent to a configured MCP OAuth flow.

Create an Access JSON file using the app's real issuer and audience, following [the example](../examples/access.json). Replace `team`, `desktop.example.com` and the illustrative 64-character audience with your Access values; the example will not authenticate a real account.

```sh
lcu-auto serve --access-config ./access.json
```

For a user service, stop the foreground server, then install it with `lcu-auto service install --access-config ./access.json` and start it. Keep the file private and stable; moving it requires updating the definition.

## Connect a named tunnel

Create a dedicated named tunnel following [Cloudflare's setup guide](https://developers.cloudflare.com/tunnel/get-started/). Configure only the intended hostname to route to `http://127.0.0.1:8789`, with a final 404 fallback. Keep the public Host header intact for the broker's authentication boundary.

Install/run `cloudflared` separately. Supply its tunnel token through an owner-private token file, not source code or command-line literals. Cloudflare Tunnel supplies connectivity; Access supplies client identity; the broker verifies the signed identity again.

The endpoint supplied to the remote MCP client is:

```text
https://desktop.example.com/mcp
```

Choose OAuth and dynamic client registration in a compatible client. Complete your own identity-provider login. Do not use the Cloudflare API token, tunnel token or local broker token as an OAuth client secret.

## Verify the chain

An anonymous request to `/mcp` should fail with an OAuth challenge, not return tools or desktop content. The challenge's resource-metadata endpoint and authorization-server metadata should be readable without desktop authorization.

After login, check `initialize`, `tools/list`, and a harmless native-app task. Split observation and input into separate calls, verify state retention and inspect the actual result. A successful health check does not prove desktop access, and a service-token test does not prove a user's OAuth login/refresh flow.

For ChatGPT, this project's broker retains state by authenticated owner and opaque conversation ID even when the platform starts a fresh HTTP client per call. Other clients can use conventional stateful MCP sessions.

Never weaken Access or JWT checks to compensate for a transient network error. Use the [troubleshooting guide](troubleshooting.md), inspect HTTP status and distinguish authentication failure from a signing-key dependency outage.

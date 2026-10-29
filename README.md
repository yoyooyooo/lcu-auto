<h1 align="center">LCU Auto</h1>
<p align="center">Computer-use tools for MCP clients, without a client-specific app-consent dialog.</p>
<p align="center"><a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a></p>
<p align="center"><a href="#install">Install</a> · <a href="#first-connection">First connection</a> · <a href="#shared-broker">Shared broker</a> · <a href="./docs/README.md">Docs</a></p>

```sh
lcu-auto mcp
```

Expose the installed [LCU runtime](https://github.com/amontlabs/lcu) as a local MCP server. Use `lcu-auto mcp --url http://127.0.0.1:8789/mcp` when local clients should share a broker with remote clients.

**Early-stage software (0.x).** This package supplies the adapter, not the desktop-control engine. Install upstream LCU and its required official ChatGPT desktop app separately. Native-app consent is automatically answered locally: by default, an offered **Always allow** choice becomes a persistent grant. Use only with clients you trust.

## Why this exists

Some MCP clients can call tools but cannot display LCU's app-approval prompts. Remote clients can also create a new MCP connection for each tool call, losing JavaScript bindings or consuming a new runtime slot every time.

LCU Auto handles recognized native-app consent locally, keeps computer-use state across related calls, and separates lightweight tool discovery from actual desktop execution. It exposes only `js` and `js_reset`; your client still decides whether to approve a tool invocation.

## Install

You need **Node.js 22.14 or later** and **Bun 1.4.3** to build from source. The installed shim and background server run Node against the built `dist/cli.js`, not Bun or TypeScript.

**npm publication is pending.** Use the source installation below; tag-driven publishing is prepared but is not an available registry release yet.

```sh
git clone https://github.com/yoyooyooo/lcu-auto.git
cd lcu-auto
bun install --frozen-lockfile
bun run build
bun run shim:install
lcu-auto --version
lcu-auto doctor
```

`doctor` checks that the installed LCU adapter can be found. It does not click an app, grant OS permissions, or prove that screenshots work. A successful check prints `LCU adapter found`.

Follow [upstream LCU installation](https://github.com/amontlabs/lcu/blob/main/docs/INSTALLATION.md) for its runtime and permissions. By default, this CLI looks under `~/.local/share/lcu` on macOS and `/opt/lcu` on Linux. Set `--lcu-dir` or `LCU_AUTO_PREFIX` for a different installation. A prefix containing `current/`, or a release directory containing `adapters/`, is accepted.

### Platform boundary

The CLI uses Node.js and platform-aware paths. CI exercises its protocol, configuration, package and CLI checks on macOS, Linux and Windows. Service definitions are available for launchd, systemd user services and Windows Task Scheduler.

**Desktop control is a separate dependency.** Upstream LCU lists Apple Silicon macOS and compatible Linux/X11 desktops; Windows is a candidate, not a supported desktop backend in this release. This project's live desktop verification is on Apple Silicon macOS. Linux desktop execution and non-macOS service installation are not claimed as live-verified. See [compatibility](docs/compatibility.md).

## First connection

Add this stdio entry to your MCP client's configuration:

```json
{
  "mcpServers": {
    "lcu-auto": {
      "command": "lcu-auto",
      "args": ["mcp"]
    }
  }
}
```

The shim is written to `~/.local/bin` (or `%LOCALAPPDATA%\lcu-auto\bin` on Windows); add that directory to PATH when necessary. Use the absolute path to the installed command when a GUI client does not inherit your shell's `PATH`. The client should list exactly **`js`** and **`js_reset`**. `mcp` itself does not print a welcome message: stdout is reserved for MCP.

Ask the client to select a harmless test app, read its state, and then perform a separate input call. Verify the visible result. Do not begin with a messaging app, an account-setting page or a valuable document.

LCU's instructions describe the `cua` API. The first `js` call selects an app or reads the inventory; subsequent calls can reuse the returned binding. Only recognized native-app consent is automated. Unknown requests are cancelled, and LCU's host-app restrictions and operating-system permissions remain in force.

## Shared broker

A broker lets local and remote clients use the same desktop queue. Create a local credential, start the server, then point local clients at it:

```sh
lcu-auto token
lcu-auto serve
```

In another terminal or in the MCP client's command configuration:

```sh
lcu-auto mcp --url http://127.0.0.1:8789/mcp
```

The credential is read from the local configuration directory; it is not placed in the MCP config or printed. All HTTP routes require authentication. The broker binds to loopback only.

For an opt-in user service:

```sh
lcu-auto service install
lcu-auto service start
lcu-auto service status
```

Installation does not start the service. Stop an existing foreground server before starting the managed service. `stop` and `restart` refuse to disconnect clients unless you explicitly pass `--force-disconnect`. Installation points to the current installed CLI; reinstall the definition after moving the installation. [Service management](docs/services.md) explains platform limitations and recovery.

### Remote access

Use a named Cloudflare Tunnel and Access Managed OAuth, then start the broker with an Access configuration file. The origin verifies the signed Access assertion instead of trusting an email header. Local bearer credentials do not authenticate requests addressed to the public hostname.

Follow the complete [remote deployment guide](docs/deployment.md). It covers prerequisites, OAuth discovery, callback registration, origin validation and verification. **A tunnel alone is not authentication.** No tunnel, account policy or DNS record is created automatically by installing this package.

## State and safety

Consecutive calls retain one computer-use control turn. Successful tool returns do not end it. For ChatGPT-style short-lived clients, the broker correlates state using the verified identity plus the opaque conversation identifier; the identifier is not authentication. Other clients use connection-owned state.

Discovery does not reserve an execution runtime. Idle runtimes are bounded and reclaimed; running actions are not evicted. Cancellation, reset and shutdown clean up before another queued operation starts. A timeout or lost response can conceal an action that already happened, so observe the desktop before retrying.

If a context becomes closed or broken, explicitly call `js_reset`: it replaces the owned LCU process without replaying previous actions, even when an HTTP reconnect still points to the failed context. This also refreshes runtime state after reinstalling the desktop app. It does not grant OS permissions. See [recovery](docs/troubleshooting.md#session-is-closed-even-after-reconnecting-or-reinstalling-the-desktop-app).

The queue serializes individual calls, not an entire multi-step task. Avoid two agents editing the same window. Screenshots and accessibility text can contain private information and are returned to your MCP client. The package does not send telemetry or retain tool results in its production logs. LCU and your client have their own behavior and terms.

The default `--scope always` can persist app grants in upstream LCU. `--scope session` or `--scope once` reduces the maximum requested persistence but does not revoke old grants. Browser-extension access is opt-in and requires exact site origins. See the [security model](docs/security-model.md).

## Commands and development

`mcp`, `serve`, `token`, `doctor`, `config paths` and `service` are the public command groups. Run `lcu-auto <command> --help` for flags, shell completions and errors. The old `connect`, `stdio` and `http` spellings remain migration aliases; new integrations should use `mcp` and `serve`.

```sh
bun install --frozen-lockfile
bun run check
bun run pack:check
```

The default tests need no installed LCU, GUI, cloud account or private credential. Live tests are explicit and separate. [Contributing](CONTRIBUTING.md) describes the checks and bilingual documentation policy; [release operations](docs/releases.md) describes immutable tags and npm trusted publishing.

[CLI reference](docs/cli.md) · [Troubleshooting](docs/troubleshooting.md) · [Architecture](docs/design.md) · [Changelog](CHANGELOG.md) · [Report a vulnerability](SECURITY.md)

MIT licensed. This project is not affiliated with OpenAI or Amont Labs. LCU is installed separately; proprietary desktop runtime assets are not redistributed. See [third-party notices](THIRD_PARTY_NOTICES.md).

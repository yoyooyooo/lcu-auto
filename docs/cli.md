# CLI reference

The parser and generated help use `effect/cli`. Runtime errors return a nonzero exit code. Tool errors remain MCP tool results where the protocol requires them. Diagnostics use stderr; `mcp` stdout is exclusively MCP.

## Commands

| Command                                               | Behavior                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| `lcu-auto mcp`                                        | Run a connection-owned stdio MCP server against installed LCU.                 |
| `lcu-auto mcp --url http://127.0.0.1:8789/mcp`        | Bridge stdio to the shared local broker using the local token file.            |
| `lcu-auto serve`                                      | Bind authenticated HTTP `/mcp` and `/healthz` to `127.0.0.1:8789`.             |
| `lcu-auto token`                                      | Create a 256-bit random local token; never overwrite or print the secret.      |
| `lcu-auto doctor --json`                              | Inspect adapter discovery without desktop interaction. Missing LCU is nonzero. |
| `lcu-auto config paths`                               | Print resolved configuration, data, state, LCU and token paths.                |
| `lcu-auto service install`                            | Write an opt-in native user-service definition pointing to this CLI.           |
| `lcu-auto service start`, `stop`, `restart`, `status` | Control or inspect the installed broker service.                               |

`--help`, `--version` and `--completions` are provided by Effect CLI. Running with no arguments shows help.

## Runtime and transport flags

`mcp` and `serve` accept `--lcu-dir PATH` (`--prefix` is an alias), `--lcu-command PATH`, `--scope always|session|once`, `--chrome`, repeated `--allow-origin ORIGIN`, and `--token-file PATH`.

`--lcu-command` replaces only the executable. The installed LCU shared adapter is still loaded from `--lcu-dir`; use a compatible trusted installation. No arbitrary downloaded code is installed automatically.

`mcp --url` only accepts an HTTP loopback `/mcp` URL without credentials, query or fragment. Use an OAuth-capable MCP client directly for a remote server. When `--url` is used, runtime flags do not reconfigure the already running broker; configure those flags on `serve` instead.

`serve` additionally accepts `--port` (1–65535, default 8789), repeated `--public-origin` (HTTPS origins), and `--access-config` (JSON file). A public origin validates Host/Origin; it is not an authentication rule.

`--allow-origin` requires `--chrome`. Origins must be exact HTTP(S) origins: no path, trailing slash, wildcard or embedded credential. Existing upstream forbidden-app and site-approval behavior remains.

## Paths

Use `lcu-auto config paths` to inspect the values rather than assuming a home directory.

| Purpose     | Unix default                                                    | Windows default           | Override                                |
| ----------- | --------------------------------------------------------------- | ------------------------- | --------------------------------------- |
| Config      | `$XDG_CONFIG_HOME/lcu-auto`, otherwise `~/.config/lcu-auto`     | `%APPDATA%\lcu-auto`      | `LCU_AUTO_CONFIG_DIR`                   |
| Data        | `$XDG_DATA_HOME/lcu-auto`, otherwise `~/.local/share/lcu-auto`  | `%LOCALAPPDATA%\lcu-auto` | `LCU_AUTO_DATA_DIR`                     |
| State       | `$XDG_STATE_HOME/lcu-auto`, otherwise `~/.local/state/lcu-auto` | `%LOCALAPPDATA%\lcu-auto` | `LCU_AUTO_STATE_DIR`                    |
| LCU         | macOS: `~/.local/share/lcu`; Linux: `/opt/lcu`                  | `%LOCALAPPDATA%\lcu`      | `LCU_AUTO_PREFIX` or `--lcu-dir`        |
| Local token | `<config>/http.token`                                           | `<config>\http.token`     | `LCU_AUTO_TOKEN_FILE` or `--token-file` |

Environment overrides must be absolute; relative values are ignored. Explicit path flags support `~` and relative paths. Windows uses home-based AppData fallbacks when APPDATA/LOCALAPPDATA are absent. POSIX 0600 checks do not represent Windows ACLs: restrict the credential file to your account there.

## Service flags

All service commands accept `--name` (default `lcu-auto`). Installation also accepts runtime location, scope, token, port and Access-file options, `--dry-run` and `--replace-existing`. Custom Chrome-enabled service arguments require your own supervisor in this version.

`--dry-run` renders a definition without changing the service manager. `--replace-existing` permits replacing an inspected non-managed definition, but never a currently registered/running service. The old definition is backed up first. `stop` and `restart` require `--force-disconnect` when clients remain or health cannot be read.

Service management does not install or control `cloudflared`.

## Migration aliases

`connect` means `mcp --url http://127.0.0.1:8789/mcp`; `stdio` means `mcp`; `http` means `serve`. A supplied `connect --url` is retained. Aliases are retained throughout the 0.4 minor line and may be removed only in a documented later minor release.

See [troubleshooting](troubleshooting.md) for recovery and [security](security-model.md) before exposing a remote endpoint.

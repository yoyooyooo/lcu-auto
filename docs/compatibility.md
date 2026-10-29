# Compatibility

LCU Auto is a Node.js CLI and an MCP transport/lifecycle adapter. LCU itself supplies computer-use behavior. These are separate support claims.

| Layer                 | Contract                                                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI runtime           | Node.js 22.14 or later, ESM; no Bun or Python required for the built CLI. Current distribution is source + global shim; npm is pending.       |
| Development           | Bun 1.4.3 and the checked-in lockfile.                                                                                                        |
| Protocol              | Official MCP SDK Streamable HTTP and stdio, with a Web Request/Response boundary served by Effect's Node platform.                            |
| Effect                | Stable `effect` and `@effect/platform-node` 4.1.0, pinned exactly. Some Effect CLI/platform modules retain upstream unstable API annotations. |
| LCU adapter           | Runtime validation of `createCuaClient`, approval helpers and the `js`/`js_reset` public surface; live baseline LCU 0.11.4.                   |
| Desktop verified here | Apple Silicon macOS with the required official ChatGPT desktop app and permissions.                                                           |
| Linux desktop         | Upstream describes Ubuntu 24.04-compatible glibc, ARM64/x64, active X11 and D-Bus. Not live-verified by this project's release checks.        |
| Windows desktop       | Deferred upstream candidate. A working CLI or Task Scheduler definition does not establish a working Windows desktop engine.                  |

The [upstream requirements](https://github.com/amontlabs/lcu#requirements) are authoritative for its current desktop backend. Intel Mac, native Wayland and musl Linux are not claimed here. Avoid inferring desktop support from a successful `--help` or CI job.

macOS user-service installation is exercised locally. Linux/systemd and Windows Task Scheduler definitions have deterministic rendering/quoting tests; actual user-session installation requires platform-specific acceptance. Headless runners do not prove graphical-session permissions.

CI covers CLI, protocol and package behavior on macOS, Linux and Windows, with Node 22 and 24 where configured. A workflow definition is not evidence that a particular run passed; consult the repository's checks and [readiness record](readiness.md).

No OpenAI application, proprietary runtime, font, screenshot or credentials are bundled. Upstream LCU remains separately installed and retains its own release/update policy.

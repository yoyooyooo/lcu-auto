# Contributing

Use Bun 1.4.3 and Node.js 22.14 or later. Clone the repository, then run:

```sh
bun install --frozen-lockfile
bun run check
bun run pack:check
```

The default suite is hermetic: it uses real MCP SDK transports with a deterministic upstream fixture, without an installed LCU, private home directory, GUI, cloud account or credential. This is protocol proof, not proof of upstream desktop behavior.

For an explicitly authorized live macOS test, install upstream LCU and run `bun run smoke:live`. The script builds a task-owned AppKit fixture, uses only that window, verifies saved bytes, and keeps evidence in ignored `.runs/`. It may persist approval for the fixture under the chosen consent policy. Never substitute a real conversation or valuable document for that fixture.

Changes to public commands require CLI/help tests and updates to both `README.md` and `README.zh-CN.md`, plus the relevant `docs/` page. Keep capability, default, limit and risk statements equivalent in both languages. Source changes must not depend on a maintainer's machine.

Preserve the execution boundaries: discovery does not allocate a permanent runtime; a successful call does not end its control turn; conversation IDs are correlation hints, never authentication; cleanup is owned and no desktop side effect is automatically retried. Use Effect for resource/platform ownership, the official MCP SDK for protocol handling, and ordinary TypeScript for pure policies.

Open a focused issue or pull request with the expected behavior, sanitized reproduction and commands run. Do not submit tokens, private hostnames, chat content, screenshots containing personal data, or full diagnostic archives. Use [private reporting](SECURITY.md) for security-sensitive findings.

Keep changes small enough to review. There is no requirement to add a framework, template or proof artifact for every helper. Generated `dist/` is rebuilt and never committed. Lockfile changes must resolve only to the public npm registry.

Maintainers tag an audited commit on `main`; contributors do not need publishing credentials. See [release operations](docs/releases.md).

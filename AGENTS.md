# LCU Auto

Read the README and relevant docs before changing public behavior. Keep source portable and the public package independent of a maintainer's machine.

- Stable Effect v4 owns CLI parsing, filesystem/process boundaries and resource lifetime. Keep the official MCP SDK as protocol owner; jose owns JWT verification.
- Expose only `js` and `js_reset`. Preserve upstream instructions, schemas, images and errors; keep truthful tool annotations.
- Never remove upstream host-app guards or OS permissions. Only recognized native-app consent is automated; unknown requests cancel.
- Verified identity owns execution state. Conversation identifiers are correlation hints, not authentication. Discovery must not allocate a permanent execution slot.
- Successful tool calls must not end the control turn. Cancellation, reset, expiry and shutdown must clean up before releasing owned resources. Never blindly retry desktop side effects.
- Default tests are hermetic. Live desktop tests are opt-in and may operate only task-owned synthetic fixtures unless a user explicitly requests another target.
- Run `bun run check` and `bun run pack:check` for changes affecting distribution. Keep both README languages and linked docs consistent.
- Never commit private endpoints, credentials, local paths, real conversations or runtime evidence. Do not publish old private Git history.
- Releases use immutable annotated tags and the verified packed artifact. Publication and deployment require explicit authorization.
- Do not permanently delete local files as cleanup; use the host's system Trash or retain a private backup.

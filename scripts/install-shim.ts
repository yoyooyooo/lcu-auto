import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Source installation helper, not an npm lifecycle hook. No shell/profile changes.
const entry = resolve("dist/cli.js");
await readFile(entry);
const probe = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" });
if (probe.status !== 0 || !probe.stdout.trim())
  throw new Error("Node.js is required to install the shim");
const node = probe.stdout.trim();
const windows = process.platform === "win32";
const directory = process.env.LCU_AUTO_BIN_DIR
  ? resolve(process.env.LCU_AUTO_BIN_DIR)
  : windows
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "lcu-auto", "bin")
    : join(homedir(), ".local", "bin");
const target = join(directory, windows ? "lcu-auto.cmd" : "lcu-auto");
const shell = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
if (windows && [node, entry].some((value) => /[%\r\n]/.test(value)))
  throw new Error("cmd shim paths cannot contain percent signs or newlines");
const content = windows
  ? `@echo off\r\nrem Managed by lcu-auto source shim\r\n"${node}" "${entry}" %*\r\n`
  : `#!/bin/sh\n# Managed by lcu-auto source shim\nexec ${shell(node)} ${shell(entry)} "$@"\n`;
await mkdir(directory, { recursive: true });
let previous: Buffer | undefined;
try {
  const info = await lstat(target);
  if (!info.isFile())
    throw new Error("Existing shim is not a regular file; inspect it before installing");
  previous = await readFile(target);
  if (
    !previous.toString().includes("lcu-auto") ||
    (!previous.toString().includes("src/cli.ts") && !previous.toString().includes("dist/cli.js"))
  )
    throw new Error("Existing command is not an identifiable lcu-auto shim");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}
if (previous?.toString() !== content) {
  if (previous) {
    const backups = join(homedir(), ".local", "state", "lcu-auto", "backups");
    await mkdir(backups, { recursive: true, mode: 0o700 });
    const backup = join(backups, `shim-${randomUUID()}.backup`);
    await copyFile(target, backup);
    await chmod(backup, 0o600);
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o755, flag: "wx" });
  await rename(temporary, target);
}
console.log(
  JSON.stringify(
    { command: target, runtime: node, entry, changed: previous?.toString() !== content },
    null,
    2,
  ),
);

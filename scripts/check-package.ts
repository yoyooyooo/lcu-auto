import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { checkDocs } from "./check-docs.ts";

export function run(command: string, args: string[], cwd = process.cwd(), capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
    shell: process.platform === "win32" && command === "npm",
    env: {
      ...process.env,
      npm_config_registry: "https://registry.npmjs.org/",
      ...(command === "npm" ? { npm_config_userconfig: join(cwd, ".npmrc") } : {}),
    },
    timeout: 300_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} failed with status ${result.status}: ${capture ? result.stderr.slice(-1200) : "see output"}`,
    );
  return result.stdout ?? "";
}

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const directory = resolve(".artifacts");
await mkdir(directory, { recursive: true });
run("bun", ["pm", "pack", "--destination", directory]);
const archive = join(directory, `${manifest.name}-${manifest.version}.tgz`);
const bytes = await readFile(archive);
const listing = run("tar", ["-tzf", archive], process.cwd(), true).trim().split(/\r?\n/);
for (const file of listing) {
  if (
    !file.startsWith("package/") ||
    file.includes("..") ||
    /(?:^|\/)(?:node_modules|\.git|\.runs|\.env|\.pi)(?:\/|$)/.test(file)
  )
    throw new Error(`Unsafe package path: ${file}`);
  if (/\.(?:ts|tsx|map|token|pem|p12)$/.test(file))
    throw new Error(`Development/private file leaked into package: ${file}`);
}
const packed = JSON.parse(
  run("tar", ["-xOf", archive, "package/package.json"], process.cwd(), true),
);
if (
  packed.name !== manifest.name ||
  packed.version !== manifest.version ||
  packed.private ||
  packed.bin?.["lcu-auto"] !== "dist/cli.js"
)
  throw new Error("Packed identity/bin differs from the public contract");
for (const value of Object.values(packed.dependencies ?? {})) {
  if (typeof value !== "string" || /^(?:catalog:|workspace:|file:|link:|git\+|https?:)/.test(value))
    throw new Error("Unresolved or non-registry runtime dependency");
}
const temporary = await mkdtemp(join(tmpdir(), "lcu-auto-pack-"));
run("tar", ["-xzf", archive, "-C", temporary]);
const links = await checkDocs(join(temporary, "package"));
const consumer = join(temporary, "consumer");
await mkdir(consumer);
await writeFile(join(consumer, "package.json"), '{"private":true}\n');
await writeFile(join(consumer, ".npmrc"), "registry=https://registry.npmjs.org/\n");
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive], consumer);
const bin = join(consumer, "node_modules", "lcu-auto", "dist", "cli.js");
const version = run("node", [bin, "--version"], consumer, true).trim();
if (!version.includes(manifest.version)) throw new Error("Installed CLI version mismatch");
run("node", [bin, "mcp", "--help"], consumer, true);
run("node", [bin, "serve", "--help"], consumer, true);
run("node", [bin, "config", "paths"], consumer, true);
// Exercise the package manager's bin link/shim, not only a direct dist path.
const executable =
  process.platform === "win32" ? "npm" : join(consumer, "node_modules", ".bin", "lcu-auto");
const installedVersion = run(
  executable,
  process.platform === "win32"
    ? ["exec", "--offline", "--", "lcu-auto", "--version"]
    : ["--version"],
  consumer,
  true,
);
if (!installedVersion.includes(manifest.version))
  throw new Error("npm-installed bin entrypoint did not execute");
const summary = {
  name: manifest.name,
  version: manifest.version,
  archive,
  integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.byteLength,
  files: listing.length,
  links,
  installedVersion: version,
  cleanConsumerInstall: true,
  developmentArtifactsExcluded: true,
};
await writeFile(join(directory, "package-check.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
// Temporary consumer directories are intentionally retained for diagnosis, not permanently deleted.

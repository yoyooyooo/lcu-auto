import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { normalizeArgs } from "../src/commands.ts";
import { VERSION } from "../src/version.ts";

function run(args: string[], configDir: string) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LCU_AUTO_CONFIG_DIR: configDir,
      LCU_AUTO_PREFIX: join(configDir, "absent-runtime"),
    },
    timeout: 15000,
  });
}
test("help, version and paths work in an isolated configuration with no LCU installation", () => {
  const directory = mkdtempSync(join(tmpdir(), "lcu-auto-cli-"));
  for (const args of [
    ["--help"],
    ["mcp", "--help"],
    ["serve", "--help"],
    ["--version"],
    ["config", "paths"],
  ]) {
    const result = run(args, directory);
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  }
  expect(run(["--version"], directory).stdout).toContain(VERSION);
  expect(JSON.parse(run(["config", "paths"], directory).stdout).configDir).toBe(directory);
  expect(run(["doctor", "--json"], directory).status).not.toBe(0);
  // This case launches eight isolated processes; a cold host's aggregate time
  // is not the latency of one CLI invocation. Each spawn remains bounded above.
}, 60_000);
test("token creation is private, does not expose its value and refuses overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "lcu-auto-token-"));
  const first = run(["token"], directory);
  expect(first.status).toBe(0);
  const file = join(directory, "http.token");
  const secret = readFileSync(file, "utf8");
  expect(secret.trim()).toMatch(/^[a-f0-9]{64}$/);
  expect(first.stdout + first.stderr).not.toContain(secret.trim());
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(run(["token"], directory).status).not.toBe(0);
  expect(readFileSync(file, "utf8")).toBe(secret);
}, 30_000);
test("legacy entrypoints map to explicit MCP or serve commands", () => {
  expect(normalizeArgs(["connect"])).toEqual(["mcp", "--url", "http://127.0.0.1:8789/mcp"]);
  expect(normalizeArgs(["stdio"])).toEqual(["mcp"]);
  expect(normalizeArgs(["http"])).toEqual(["serve"]);
});

test("service dry-run does not require destructive flags or create a definition", () => {
  const directory = mkdtempSync(join(tmpdir(), "lcu-auto-service-cli-"));
  const result = run(["service", "install", "--dry-run"], directory);
  expect(result.status).toBe(0);
  const plan = JSON.parse(result.stdout);
  expect(plan.installed).toBe(false);
  expect(typeof plan.definitionPath).toBe("string");
  const doctor = run(["doctor"], directory);
  expect(doctor.stderr).not.toContain("Missing required flag");
}, 30_000);

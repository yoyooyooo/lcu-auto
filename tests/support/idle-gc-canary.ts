/**
 * A disposable HTTP MCP server for testing real Agent clients against the GC
 * contract, without launching LCU or touching the user's actual desktop.
 *
 * Creates private local run files under .runs/ah678-canary. Never prints a token.
 */
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startHttp } from "../../src/http.ts";
import type { Upstream } from "../../src/lcu.ts";

const root = resolve(".runs/ah678-canary");
await mkdir(root, { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString("hex");
await writeFile(resolve(root, "token"), `${token}\n`, { mode: 0o600 });
let generations = 0;
let effects = 0;
let simulatedElapsedMs = 0;
const factory = (): Upstream => {
  const id = ++generations;
  return {
    instructions:
      "This is a SYNTHETIC GC fixture, not a real desktop. Tools respond with controlled synthetic JSON. Do not claim to have operated a real app.",
    async connect() {},
    publicTools: () =>
      ["js", "js_reset"].map((name) => ({
        name,
        description:
          name === "js" ? "Return synthetic desktop state" : "Initialize a fresh synthetic state",
        inputSchema: { type: "object", properties: { code: { type: "string" } } },
      })),
    async call(name, args) {
      if (name === "js") effects++;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              synthetic: true,
              generation: id,
              calls: effects,
              request: name,
              code: typeof args.code === "string" ? args.code : "",
            }),
          },
        ],
      };
    },
    async turnEnded() {},
    async close() {},
  };
};
const server = await startHttp(
  factory,
  {
    token,
    port: 0,
    publicOrigins: [],
    idleMs: 120_000,
    discoveryIdleMs: 120_000,
    now: () => performance.now() + simulatedElapsedMs,
  },
  () => {},
);
await writeFile(resolve(root, "endpoint.json"), JSON.stringify({ url: server.url }), {
  mode: 0o600,
});
process.stdout.write("AH678_CANARY_READY\n");
process.on("SIGUSR2", () => {
  simulatedElapsedMs += 120_001;
  void server.sweep().then(() => process.stdout.write("AH678_SIMULATED_EXPIRY\n"));
});
const close = async () => {
  await server.close();
  process.exitCode = 0;
};
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});

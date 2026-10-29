import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.platform !== "darwin")
  throw new Error(
    "The live AppKit fixture is macOS-only; hermetic checks run on every supported CLI platform",
  );
await mkdir(".runs", { recursive: true });
const directory = await mkdtemp(resolve(".runs/live-"));
const app = join(directory, "LCU Auto Verification.app");
await mkdir(join(app, "Contents", "MacOS"), { recursive: true });
await writeFile(
  join(app, "Contents", "Info.plist"),
  `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Verification</string>
<key>CFBundleIdentifier</key><string>org.lcuauto.verification</string>
<key>CFBundleName</key><string>LCU Auto Verification</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>NSPrincipalClass</key><string>NSApplication</string></dict></plist>`,
);
for (const [command, ...args] of [
  [
    "swiftc",
    "tests/native-fixture.swift",
    "-o",
    join(app, "Contents", "MacOS", "Verification"),
    "-framework",
    "AppKit",
  ],
  ["codesign", "--force", "--sign", "-", app],
]) {
  if (!command || spawnSync(command, args, { stdio: "inherit" }).status !== 0)
    throw new Error("Native fixture build failed");
}
const entry = resolve(process.env.LCU_AUTO_CLI ?? "dist/cli.js");
const client = new Client({ name: "lcu-auto-live-verifier", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.env.LCU_AUTO_NODE ?? "node",
  args: [entry, "mcp", ...process.argv.slice(2)],
  stderr: "pipe",
});
transport.stderr?.on("data", () => {});
let calls = 0;
async function invoke(code: string) {
  const result = CallToolResultSchema.parse(
    await client.callTool(
      { name: "js", arguments: { code, title: "Verify only the task-owned fixture" } },
      undefined,
      { timeout: 90_000 },
    ),
  );
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  await writeFile(join(directory, `call-${++calls}.json`), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  if (result.isError)
    throw new Error(`Live fixture operation failed; inspect private evidence at ${directory}`);
  return { text, result };
}
try {
  await client.connect(transport);
  const first = await invoke(`var app = await cua.getApp(${JSON.stringify(app)});`);
  if (!first.text.includes("lcu-auto-editor")) throw new Error("Wrong target; refusing any input");
  await invoke('await app.pressKey("super+a");');
  const expected = `LCU_AUTO_PACKAGE_${randomUUID()}\n中文输入与跨调用状态验证。\n`;
  await invoke(`await app.paste(${JSON.stringify(expected)});`);
  await invoke('await app.pressKey("super+s");');
  const saved = await readFile(join(directory, "saved.txt"), "utf8");
  if (saved !== expected) throw new Error("Saved bytes differ from UI input");
  const observation = await invoke("await app.getAXStateAndScreenshot();");
  const images = observation.result.content.filter((block) => block.type === "image");
  if (!observation.text.includes(expected.trim()) || !images.length)
    throw new Error("Verification text or image missing from the observation");
  for (const [index, image] of images.entries()) {
    await writeFile(
      join(directory, `screenshot-${index}.${image.mimeType === "image/png" ? "png" : "jpg"}`),
      Buffer.from(image.data, "base64"),
      { mode: 0o600 },
    );
  }
  const reset = CallToolResultSchema.parse(
    await client.callTool({ name: "js_reset", arguments: {} }),
  );
  if (reset.isError) throw new Error("Live reset failed");
  await invoke(`var app = await cua.getApp(${JSON.stringify(app)});`);
  await invoke(`var state = await app.getAXState({ emit: false, disableDiffing: true });
if (!state.includes('Window: "LCU Auto Verification"') || !state.includes("lcu-auto-editor")) throw new Error("Wrong target; refusing close");
await app.pressKey("super+w");`);
  const result = {
    status: "passed",
    cli: entry,
    calls,
    separateObservationAndInput: true,
    unicodeSavedBytesMatched: true,
    screenshotCount: images.length,
    resetPassed: true,
    ownWindowClosed: true,
  };
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, evidenceDirectory: directory }, null, 2));
} finally {
  await client.close();
}

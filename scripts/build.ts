import { chmod, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const manifest = JSON.parse(await readFile("package.json", "utf8"));
if (manifest.name !== "lcu-auto" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version))
  throw new Error("Unexpected package identity/version");
const version = `export const VERSION = ${JSON.stringify(manifest.version)};\n`;
if ((await readFile("src/version.ts", "utf8")) !== version)
  await writeFile("src/version.ts", version);
await mkdir("dist", { recursive: true });
const result = spawnSync(
  process.execPath,
  [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const expected = new Set(
  (await readdir("src"))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.replace(/\.ts$/, ".js")),
);
for (const file of await readdir("dist"))
  if (!expected.has(file))
    throw new Error(
      `Unexpected stale build output: dist/${file}. Move old dist to your system Trash, then build again.`,
    );
await chmod("dist/cli.js", 0o755);
console.log(`Built ${manifest.name}@${manifest.version} for Node.js`);

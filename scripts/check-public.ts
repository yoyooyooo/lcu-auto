import { readFile, lstat } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
});
if (result.status !== 0) throw new Error("Run the public-tree check from a Git checkout");
const files = [...new Set(result.stdout.split("\0").filter(Boolean))];
const patterns = [
  /\b(?:npm_|gh[pousr]_)[A-Za-z0-9]{30,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\/Users\/(?!tester\/|example\/|user\/)[A-Za-z0-9._-]+\//,
  /https?:\/\/(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+)(?::\d+)?\//,
];
let checked = 0;
for (const file of files) {
  let info;
  try {
    info = await lstat(file);
  } catch {
    continue;
  }
  if (!info.isFile()) continue;
  if (
    /^(?:\.runs|\.pi|node_modules|dist)\//.test(file) ||
    /(?:\.token|\.pem|\.p12)$/.test(file) ||
    /^\.env(?:\.|$)/.test(file)
  ) {
    throw new Error(`Private/generated file is tracked or unignored: ${file}`);
  }
  const text = await readFile(file, "utf8");
  if (file !== "scripts/check-public.ts" && patterns.some((pattern) => pattern.test(text)))
    throw new Error(
      `Potential private data in ${file}; inspect locally (matched value is not printed)`,
    );
  if (file === "bun.lock") {
    for (const match of text.matchAll(/https?:\/\/([^/"\s]+)/g)) {
      if (match[1] !== "registry.npmjs.org")
        throw new Error("Lockfile contains a non-public-registry download URL");
    }
  }
  checked++;
}
console.log(
  `Public-tree privacy checks passed for ${checked} files; this is not a substitute for review.`,
);

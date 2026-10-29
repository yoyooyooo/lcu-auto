import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

async function markdownFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".runs", ".artifacts"].includes(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(root, path)));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

function anchorIds(source: string): Set<string> {
  const ids = new Set<string>();
  const counts = new Map<string, number>();
  const plain = source.replace(/```[^]*?```/g, "");
  for (const match of plain.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const value = (match[1] ?? "")
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = counts.get(value) ?? 0;
    counts.set(value, count + 1);
    ids.add(count ? `${value}-${count}` : value);
  }
  for (const match of plain.matchAll(/(?:id|name)=["']([^"']+)["']/g))
    if (match[1]) ids.add(match[1]);
  return ids;
}

/** Validate links against either the source tree or the extracted npm package. */
export async function checkDocs(root = process.cwd()): Promise<number> {
  let checked = 0;
  for (const file of await markdownFiles(root)) {
    const source = await readFile(file, "utf8");
    const plain = source.replace(/```[^]*?```/g, "");
    const targets = [
      ...Array.from(plain.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), (match) => match[1]),
      ...Array.from(plain.matchAll(/(?:href|src)=["']([^"']+)["']/g), (match) => match[1]),
      ...Array.from(plain.matchAll(/^\[[^\]]+\]:\s+(\S+)/gm), (match) => match[1]),
    ];
    for (const target of targets) {
      if (!target || /^(?:https?:|mailto:|data:)/.test(target)) continue;
      const [pathPart = "", hash] = target.split("#", 2);
      const absolute = resolve(dirname(file), decodeURIComponent(pathPart || "."));
      const destination = pathPart ? absolute : file;
      if (relative(root, destination).startsWith(".."))
        throw new Error(`Documentation link escapes package: ${relative(root, file)} -> ${target}`);
      try {
        await stat(destination);
      } catch {
        throw new Error(`Broken documentation link: ${relative(root, file)} -> ${target}`);
      }
      if (hash && destination.endsWith(".md")) {
        const anchors = anchorIds(await readFile(destination, "utf8"));
        if (!anchors.has(decodeURIComponent(hash)))
          throw new Error(`Missing anchor: ${relative(root, file)} -> ${target}`);
      }
      checked++;
    }
  }
  for (const name of ["README.md", "README.zh-CN.md"]) {
    const source = await readFile(join(root, name), "utf8");
    const h1 = [...source.matchAll(/^#\s+|<h1\b/gm)].length;
    if (h1 !== 1 || !source.includes('<h1 align="center">'))
      throw new Error(`${name} must have one centered H1`);
    const other = name === "README.md" ? "README.zh-CN.md" : "README.md";
    if (!source.includes(`href="./${other}"`))
      throw new Error(`${name} is missing its language switch`);
  }
  return checked;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Documentation links and anchors checked: ${await checkDocs()}`);
}

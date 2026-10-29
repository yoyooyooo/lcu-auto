import { fileURLToPath } from "node:url";
import { defaultPrefix } from "../src/lcu.ts";
import { upstreamFactory } from "./support/upstream.ts";
import { startStdio } from "../src/stdio.ts";
const command = [process.execPath, fileURLToPath(new URL("./fixture-mcp.ts", import.meta.url))];
if (process.argv[2]) command.push(process.argv[2]);
const factory = await upstreamFactory(
  { prefix: defaultPrefix, scope: "always", origins: [], chrome: false },
  () => {},
  command,
);
await startStdio(factory);

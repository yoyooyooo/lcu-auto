import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "./version.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toolResult } from "./lcu.ts";

/** Local MCP client connects to the same desktop queue as remote clients, without an OAuth UI. */
export async function startConnect(url: string, token: string, onclose: () => void = () => {}) {
  const target = new URL(url);
  if (
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(target.hostname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== "/mcp"
  ) {
    throw new Error(
      "connect requires a loopback HTTP /mcp endpoint; use an OAuth-capable client for remote access.",
    );
  }
  const client = new Client({ name: "lcu-auto-local", version: VERSION }, { capabilities: {} });
  const http = new StreamableHTTPClientTransport(target, {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  let server: Server | undefined;
  let closing: Promise<void> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    if (heartbeat) clearInterval(heartbeat);
    process.stdin.removeListener("end", eof);
    closing = (async () => {
      try {
        await http.terminateSession();
      } finally {
        try {
          await client.close();
        } finally {
          await server?.close();
          onclose();
        }
      }
    })();
    return closing;
  };
  const eof = () => {
    void close().catch(() => {
      process.stderr.write("lcu-auto: local connection cleanup failed\n");
    });
  };
  try {
    await client.connect(http);
    const surface = await client.listTools();
    server = new Server(
      { name: "lcu-auto", version: VERSION },
      {
        capabilities: { tools: {} },
        instructions: client.getInstructions() ?? "",
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => surface);
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!["js", "js_reset"].includes(request.params.name)) throw new Error("Unknown tool");
      return toolResult(
        await client.callTool(
          { name: request.params.name, arguments: request.params.arguments ?? {} },
          undefined,
          { signal: extra.signal, timeout: 360_000 },
        ),
      );
    });
    server.onclose = eof;
    client.onclose = eof;
    process.stdin.once("end", eof);
    await server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded) eof();
    // A live local client owns its session even while it is waiting for the next user prompt.
    heartbeat = setInterval(() => {
      void client.ping().catch(eof);
    }, 60_000);
    heartbeat.unref();
    return { close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

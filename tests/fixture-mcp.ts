import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const trace = process.argv[2];
const record = (value: unknown) => {
  if (trace) appendFileSync(trace, JSON.stringify(value) + "\n");
};
const server = new Server(
  { name: "lcu-fixture", version: "1" },
  { capabilities: { tools: {} }, instructions: "Original fixture instructions must survive." },
);
let memory = 0;
let failCleanup = false;
const activeTurns = new Set<string>();
const tools = ["js", "js_reset", "turn_ended", "js_add_node_module_dir"].map((name) => ({
  name,
  description: `original:${name}`,
  inputSchema: { type: "object" as const, properties: { code: { type: "string" } } },
}));
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === "turn_ended") {
    record({ event: "turn_ended", ...args });
    if (failCleanup)
      return { isError: true, content: [{ type: "text", text: "fixture cleanup failure" }] };
    activeTurns.delete(JSON.stringify([args.session_id, args.turn_id]));
    return text({ ended: true });
  }
  const code = args.code;
  record({ event: "call", code, meta: request.params._meta });
  if (request.params.name === "js_reset") {
    memory = 0;
    activeTurns.clear();
    return text({ reset: true });
  }
  const metadata = request.params._meta?.["x-codex-turn-metadata"];
  const turnKey =
    metadata && typeof metadata === "object" && "session_id" in metadata && "turn_id" in metadata
      ? JSON.stringify([metadata.session_id, metadata.turn_id])
      : undefined;
  if (code === "observe") {
    if (!turnKey) throw new Error("Missing control turn identity");
    activeTurns.add(turnKey);
    return text({ active: true });
  }
  if (code === "action") {
    if (!turnKey || !activeTurns.has(turnKey))
      return {
        isError: true,
        content: [
          { type: "text", text: "Computer Use is not active; observe in this turn first." },
        ],
      };
    return text({ actionExecuted: true });
  }
  if (code === "set") {
    memory = 42;
    return text({ memory });
  }
  if (code === "get") return text({ memory });
  if (code === "meta") return text(request.params._meta);
  if (code === "env")
    return text({
      gatewayToken: process.env.LCU_AUTO_TOKEN ?? null,
      apiKey: process.env.OPENAI_API_KEY ?? null,
      hostGuard: process.env.LCU_ALLOW_AGENT_HOST_APPROVAL,
    });
  if (code === "fail-cleanup") {
    failCleanup = true;
    return text({ sideEffect: true });
  }
  // Model an upstream process disappearing during an application reinstall.
  if (code === "disconnect") process.exit(0);
  if (code === "error")
    return { isError: true, content: [{ type: "text", text: "original tool error" }] };
  if (code === "image")
    return {
      content: [
        { type: "text", text: "original image" },
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZsAAAAASUVORK5CYII=",
        },
      ],
    };
  if (code === "slow") {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      extra.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          record({ event: "cancelled" });
          resolve();
        },
        { once: true },
      );
    });
    return text({ done: true });
  }
  if (code === "unknown")
    return text(
      await server.elicitInput({
        mode: "form",
        message: "Unknown request",
        requestedSchema: { type: "object", properties: { password: { type: "string" } } },
      }),
    );
  if (typeof code === "string" && ["approve", "session", "once", "host"].includes(code)) {
    return text(
      await server.elicitInput({
        mode: "form",
        message: "Allow Computer Use to control fixture?",
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          connector_id: "computer-use",
          tool_params: {
            app: code === "host" ? "com.apple.Terminal" : "com.example.LcuAutoFixture",
          },
          persist:
            code === "approve" ? ["session", "always"] : code === "session" ? ["session"] : [],
        },
      }),
    );
  }
  return text({ ok: true });
});
await server.connect(new StdioServerTransport());

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { autoApproval, type Audit, type RuntimeOptions, type Upstream } from "../../src/lcu.ts";
import { childEnvironment as childEnvironmentForTest } from "../../src/policy.ts";

/** Deterministic wire fixture, not a copy of LCU and not proof of its platform permissions. */
export async function upstreamFactory(
  options: RuntimeOptions,
  audit: Audit,
  command?: string[],
): Promise<() => Upstream> {
  if (!command?.[0]) throw new Error("Test fixture command is required");
  const executable = command[0];
  return () => {
    const client = new Client(
      { name: "lcu-auto-test-upstream", version: "1" },
      { capabilities: { elicitation: { form: {} } } },
    );
    const transport = new StdioClientTransport({
      command: executable,
      args: command.slice(1),
      env: childEnvironmentForTest(process.env),
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    let instructions = "";
    let tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    const consent = autoApproval(
      {
        nativeAppApprovalOptions(params: unknown) {
          const request = ElicitRequestSchema.parse({
            method: "elicitation/create",
            params,
          }).params;
          const meta = request._meta;
          if (
            meta?.connector_id !== "computer-use" ||
            typeof meta.tool_params !== "object" ||
            !meta.tool_params
          )
            return undefined;
          const app = Reflect.get(meta.tool_params, "app");
          if (typeof app !== "string") return undefined;
          const persistence = Array.isArray(meta.persist) ? meta.persist : [];
          return {
            resource: app,
            choices: ["once", ...persistence].map((value) => ({ value, label: value })),
          };
        },
        nativeAppApprovalResponse(
          _params: unknown,
          scope: "always" | "session" | "once",
        ): ElicitResult {
          return {
            action: "accept",
            content: {},
            ...(scope === "once" ? {} : { _meta: { persist: scope } }),
          };
        },
      },
      options.scope,
      audit,
    );
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      consent(request.params, { signal: extra.signal }),
    );
    return {
      get instructions() {
        return instructions;
      },
      async connect() {
        await client.connect(transport);
        instructions = client.getInstructions() ?? "";
        tools = (await client.listTools()).tools.filter((tool) =>
          ["js", "js_reset"].includes(tool.name),
        );
      },
      publicTools: () => tools,
      call: (name, args, context) =>
        client.callTool(
          {
            name,
            arguments: args,
            _meta: {
              "x-codex-turn-metadata": {
                session_id: context.sessionId,
                turn_id: context.turnId,
                tool_call_id: context.toolCallId,
              },
            },
          },
          undefined,
          { signal: context.signal },
        ),
      async turnEnded(context) {
        const result = await client.callTool({
          name: "turn_ended",
          arguments: {
            session_id: context.sessionId,
            turn_id: context.turnId,
            hook_event_name: context.event,
          },
        });
        if (result.isError) throw new Error("Fixture cleanup failed");
        return result;
      },
      close: () => client.close(),
    };
  };
}

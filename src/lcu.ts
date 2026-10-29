import { realpath, access } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CallToolResultSchema,
  ElicitResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, ElicitResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { Schema } from "effect";
import { runtimePaths } from "./paths.ts";
import { childEnvironment, chooseScope, type ApprovalScope } from "./policy.ts";

export interface Upstream {
  connect(): Promise<unknown>;
  readonly instructions: string;
  publicTools(): unknown;
  call(
    name: string,
    args: Record<string, unknown>,
    context: {
      sessionId: string;
      turnId: string;
      toolCallId: string;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  turnEnded(context: {
    sessionId: string;
    turnId: string;
    event: "Stop" | "Interrupt";
  }): Promise<unknown>;
  close(): Promise<void>;
}

interface AdapterModule {
  createCuaClient(options: {
    command: string[];
    env: Record<string, string>;
    adapter: string;
    allowedOrigins: string[];
    onElicitation: (params: unknown, context: { signal: AbortSignal }) => Promise<ElicitResult>;
    log: { event: (event: string, fields?: Record<string, unknown>) => void };
  }): Upstream;
  nativeAppApprovalOptions(params: unknown): unknown;
  nativeAppApprovalResponse(params: unknown, scope: ApprovalScope): unknown;
}

export interface RuntimeOptions {
  prefix: string;
  scope: ApprovalScope;
  origins: string[];
  chrome: boolean;
}
export const defaultPrefix = runtimePaths().lcuDir;

export type Audit = (event: string, fields?: Record<string, string | number | boolean>) => void;
export const stderrAudit: Audit = (event, fields = {}) => {
  process.stderr.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + "\n");
};

const approvalSchema = Schema.Struct({
  resource: Schema.String.check(Schema.isMinLength(1)),
  choices: Schema.Array(Schema.Struct({ value: Schema.String, label: Schema.String })),
});

export async function loadAdapter(
  prefix: string,
): Promise<{ module: AdapterModule; release: string }> {
  // Pin the resolved generation for the lifetime of this process, not the moving current symlink.
  let release: string;
  try {
    release = await realpath(join(prefix, "current"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    release = await realpath(prefix);
  }
  await access(join(release, "adapters", "client.mjs"));
  const candidate: unknown = await import(pathToFileURL(join(release, "adapters/client.mjs")).href);
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !("createCuaClient" in candidate) ||
    typeof candidate.createCuaClient !== "function" ||
    !("nativeAppApprovalOptions" in candidate) ||
    typeof candidate.nativeAppApprovalOptions !== "function" ||
    !("nativeAppApprovalResponse" in candidate) ||
    typeof candidate.nativeAppApprovalResponse !== "function"
  ) {
    throw new Error(
      "Installed LCU is missing the shared adapter contract; no runtime was started.",
    );
  }
  // The only foreign-module cast. Required exports are checked above; all protocol results are parsed below.
  return { module: candidate as AdapterModule, release };
}

export function autoApproval(
  module: Pick<AdapterModule, "nativeAppApprovalOptions" | "nativeAppApprovalResponse">,
  maximum: ApprovalScope,
  audit: Audit = stderrAudit,
) {
  return async (params: unknown, { signal }: { signal: AbortSignal }): Promise<ElicitResult> => {
    if (signal.aborted) return { action: "cancel" };
    let native: typeof approvalSchema.Type;
    try {
      native = Schema.decodeUnknownSync(approvalSchema)(module.nativeAppApprovalOptions(params));
    } catch {
      audit("approval_cancelled", { reason: "unrecognized_or_not_native_app" });
      return { action: "cancel" };
    }
    const scope = chooseScope(
      native.choices.map((choice) => choice.value),
      maximum,
    );
    if (!scope) return { action: "cancel" };
    const result = ElicitResultSchema.parse(module.nativeAppApprovalResponse(params, scope));
    audit("native_app_approval", { app: native.resource, scope, action: result.action });
    return result;
  };
}

export async function upstreamFactory(
  options: RuntimeOptions,
  audit: Audit = stderrAudit,
  commandOverride?: string[],
): Promise<() => Upstream> {
  if (process.env.LCU_ALLOW_AGENT_HOST_APPROVAL === "1") {
    throw new Error("Unset LCU_ALLOW_AGENT_HOST_APPROVAL; lcu-auto retains LCU's host-app guard.");
  }
  const { module, release } = await loadAdapter(options.prefix);
  const command = commandOverride ?? [
    join(release, "bin", process.platform === "win32" ? "lcu.exe" : "lcu"),
    ...(options.chrome ? ["--chrome"] : []),
  ];
  return () =>
    module.createCuaClient({
      command,
      adapter: "lcu-auto",
      env: childEnvironment(process.env),
      allowedOrigins: options.origins,
      onElicitation: autoApproval(module, options.scope, audit),
      log: {
        event(event, fields = {}) {
          const safe: Record<string, string | number | boolean> = {};
          for (const [key, value] of Object.entries(fields)) {
            if (typeof value === "number" || typeof value === "boolean") safe[key] = value;
            else if (
              ["tool", "kind", "outcome", "scope", "hook_event", "sky_hook"].includes(key) &&
              typeof value === "string"
            ) {
              safe[key] = value.slice(0, 100);
            }
          }
          audit(event.startsWith("upstream_") ? event : `upstream_${event}`, safe);
        },
      },
    });
}

export function publicSurface(upstream: Upstream): { tools: Tool[]; instructions: string } {
  const parsed = ListToolsResultSchema.parse({ tools: upstream.publicTools() });
  const names = parsed.tools.map((tool) => tool.name);
  if (names.length !== 2 || !names.includes("js") || !names.includes("js_reset")) {
    throw new Error("LCU's public tools must be exactly js and js_reset.");
  }
  if (typeof upstream.instructions !== "string")
    throw new Error("LCU instructions are not a string.");
  // The bundled runtime marks js read-only despite arbitrary UI writes. Remote clients need truthful hints.
  const tools = parsed.tools.map((tool) => ({
    ...tool,
    annotations: {
      ...tool.annotations,
      readOnlyHint: false,
      destructiveHint: tool.name === "js",
      openWorldHint: tool.name === "js",
      idempotentHint: false,
    },
  }));
  return { tools, instructions: upstream.instructions };
}

export function toolResult(raw: unknown): CallToolResult {
  CallToolResultSchema.parse(raw);
  // Preserve the full original result, including extension fields that the schema might strip.
  return raw as CallToolResult;
}

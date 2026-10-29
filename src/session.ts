import { randomUUID } from "node:crypto";
import { VERSION } from "./version.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { publicSurface, toolResult, stderrAudit, type Audit, type Upstream } from "./lcu.ts";

/** Serialize calls and lifecycle cleanup against the same desktop. */
export class DesktopQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  run<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 16)
      return Promise.reject(new Error("Desktop queue is full; no action was started."));
    return this.enqueue(signal, operation);
  }
  /** Resource finalization must not be refused because ordinary requests filled the queue. */
  cleanup<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(undefined, operation);
  }
  private async enqueue<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.pending++;
    const prior = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior;
      signal?.throwIfAborted();
      return await operation();
    } finally {
      this.pending--;
      release();
    }
  }
}

const errorResult = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

export async function createExecution(
  factory: () => Upstream,
  queue: DesktopQueue,
  audit: Audit = stderrAudit,
) {
  const upstream = factory();
  try {
    await upstream.connect();
  } catch (error) {
    await upstream.close().catch(() => {});
    throw error;
  }
  let surface: ReturnType<typeof publicSurface>;
  try {
    surface = publicSurface(upstream);
  } catch (error) {
    await upstream.close();
    throw error;
  }
  const sessionId = randomUUID();
  const stop = new AbortController();
  const running = new Set<Promise<CallToolResult>>();
  let state: "open" | "broken" | "closing" | "closed" = "open";
  let closing: Promise<void> | undefined;
  let touched = Date.now();
  // This is the adapter's control turn, not a guessed host conversation turn.
  // Ending it after a successful tools/call makes the next app input inactive.
  let controlTurn: { id: string } | undefined;

  async function endControlTurn(event: "Stop" | "Interrupt") {
    const turn = controlTurn;
    if (!turn) return;
    // Retire once even if cleanup fails. A failed cleanup poisons this session;
    // shutdown must not retry it through an already closed upstream client.
    controlTurn = undefined;
    try {
      await upstream.turnEnded({ sessionId, turnId: turn.id, event });
      audit("control_turn_ended", { hook_event: event });
    } catch {
      state = "broken";
      audit("cleanup_failed");
      await upstream.close().catch(() => {});
      throw new Error(
        "LCU cleanup failed. This session is disabled and its upstream connection was closed. The operation may have executed; inspect the desktop before reconnecting.",
      );
    }
  }

  async function call(
    name: string,
    args: Record<string, unknown>,
    context: { requestId: string | number; signal: AbortSignal },
  ): Promise<CallToolResult> {
    if (state !== "open")
      return errorResult(
        "This LCU session is closed or its cleanup failed. Reconnect before another action.",
      );
    if (name !== "js" && name !== "js_reset")
      return errorResult("Host-only tools are not exposed.");
    const signal = AbortSignal.any([context.signal, stop.signal]);
    const work = queue
      .run(signal, async () => {
        if (state !== "open")
          return errorResult("Session closed before execution; no action was started.");
        // End the live worker's turn before reset. Do not rely on the upstream reset
        // helper, which may swallow cleanup failures before destroying the worker.
        if (name === "js_reset") await endControlTurn("Interrupt");
        signal.throwIfAborted();
        const turnId = name === "js" ? (controlTurn ??= { id: randomUUID() }).id : randomUUID();
        const started = Date.now();
        let result: CallToolResult;
        let interrupted = false;
        try {
          // Never forward client-controlled runtime/sandbox metadata.
          result = toolResult(
            await upstream.call(name, args, {
              sessionId,
              turnId,
              toolCallId: String(context.requestId),
              signal,
            }),
          );
        } catch (error) {
          interrupted = true;
          result = errorResult(
            signal.aborted
              ? "Operation cancelled. Earlier desktop effects may already have occurred; observe the target before another action and do not blindly retry."
              : error instanceof Error
                ? error.message
                : "LCU operation failed.",
          );
        }
        // A returned tool error is not a lifecycle event; allow the model to inspect
        // and recover. Cancellation or a transport failure ends the active turn.
        if (interrupted || signal.aborted) await endControlTurn("Interrupt");
        audit("operation_finished", {
          tool: name,
          ms: Date.now() - started,
          error: result.isError === true,
          interrupted: interrupted || signal.aborted,
        });
        return result;
      })
      .catch((error) =>
        errorResult(error instanceof Error ? error.message : "Operation was not started."),
      );
    running.add(work);
    try {
      return await work;
    } finally {
      running.delete(work);
      touched = Date.now();
    }
  }
  const session = {
    surface,
    call,
    get active() {
      return running.size;
    },
    get touched() {
      return touched;
    },
    touch() {
      touched = Date.now();
    },
    close(): Promise<void> {
      if (closing) return closing;
      const hadInFlightCalls = running.size > 0;
      state = "closing";
      stop.abort();
      closing = (async () => {
        await Promise.allSettled(running);
        try {
          await queue.cleanup(async () => {
            try {
              await endControlTurn(hadInFlightCalls ? "Interrupt" : "Stop");
            } finally {
              await upstream.close();
            }
          });
        } finally {
          state = "closed";
        }
      })();
      return closing;
    },
  };
  return session;
}
export type Execution = Awaited<ReturnType<typeof createExecution>>;
export type Surface = ReturnType<typeof publicSurface>;
export type ToolCall = Execution["call"];

/** Transport/protocol instances contain no desktop state. They may be short lived. */
export function createMcpServer(surface: Surface, call: ToolCall, audit: Audit = stderrAudit) {
  const server = new Server(
    { name: "lcu-auto", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        surface.instructions +
        "\nLCU Auto: native-app consent is handled locally. Consecutive js calls share a persistent REPL and Computer Use turn in their logical context. ChatGPT contexts are scoped by the authenticated principal and openai/session, not by an HTTP connection. Successful calls and HTTP reconnects do not end the turn. Cancellation and js_reset end it; observe the target again before input. Contexts expire after inactivity and are lost on service restart. If an error mentions get_app_state, use app.getAXState() or cua.getApp(...) inside js. There is no separate get_app_state MCP tool.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: surface.tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    !["js", "js_reset"].includes(request.params.name)
      ? errorResult("Host-only tools are not exposed.")
      : call(request.params.name, request.params.arguments ?? {}, {
          requestId: extra.requestId,
          signal: extra.signal,
        }),
  );
  server.onerror = () => audit("mcp_transport_error");
  return server;
}

/** Standalone stdio retains its connection-owned lifetime. */
export async function createSession(
  factory: () => Upstream,
  queue: DesktopQueue,
  audit: Audit = stderrAudit,
) {
  const execution = await createExecution(factory, queue, audit);
  const server = createMcpServer(execution.surface, execution.call, audit);
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      try {
        await execution.close();
      } finally {
        await server.close();
      }
    })());
  server.onclose = () => {
    void close().catch(() => audit("session_close_failed"));
  };
  return {
    server,
    close,
    get active() {
      return execution.active;
    },
    get touched() {
      return execution.touched;
    },
    touch: execution.touch,
  };
}
export type Session = Awaited<ReturnType<typeof createSession>>;

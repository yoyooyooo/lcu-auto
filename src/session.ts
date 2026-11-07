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

/** A failed cleanup must retain its execution slot, even when startup failed. */
export class UpstreamTeardownUnconfirmedError extends Error {
  constructor() {
    super("LCU upstream teardown was not confirmed; this execution slot is quarantined.");
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
  options: { coldReset?: boolean } = {},
) {
  let upstream = factory();
  let surface: ReturnType<typeof publicSurface>;
  try {
    await upstream.connect();
    surface = publicSurface(upstream);
  } catch (error) {
    try {
      await upstream.close();
    } catch {
      throw new UpstreamTeardownUnconfirmedError();
    }
    throw error;
  }
  let sessionId = randomUUID();
  let upstreamClose: Promise<void> | undefined;
  const closeUpstream = () => {
    const owned = upstream;
    // Retain rejected teardown too: a later reset must not mistake an idempotent
    // second close for confirmation that a failed first teardown succeeded.
    return (upstreamClose ??= Promise.resolve().then(() => owned.close()));
  };
  const stop = new AbortController();
  const running = new Set<Promise<CallToolResult>>();
  let state: "open" | "broken" | "closing" | "closed" = "open";
  let coldReset = options.coldReset === true;
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
      await closeUpstream().catch(() => audit("upstream_close_failed"));
      throw new Error(
        "LCU cleanup failed. Further actions are disabled. Call js_reset to replace the runtime; reconnecting alone retains this logical context. The operation may have executed, so observe the target before another action.",
      );
    }
  }

  async function resetRuntime(
    args: Record<string, unknown>,
    context: { requestId: string | number; signal: AbortSignal },
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    // A reset for a missing/expired logical context starts one generation only.
    // A retained context's explicit reset must still replace its existing runtime.
    if (coldReset) {
      coldReset = false;
      try {
        const result = toolResult(
          await upstream.call("js_reset", args, {
            sessionId,
            turnId: randomUUID(),
            toolCallId: String(context.requestId),
            signal,
          }),
        );
        signal.throwIfAborted();
        if (result.isError) {
          state = "broken";
          await closeUpstream();
          return result;
        }
        audit("runtime_initialized_after_expiry");
        return {
          ...result,
          content: [
            ...result.content,
            {
              type: "text",
              text: "A new LCU runtime was initialized. Previous JavaScript bindings are gone. Reacquire the app and observe the current UI before any input. No earlier action was replayed.",
            },
          ],
        };
      } catch (error) {
        state = "broken";
        await closeUpstream().catch(() => audit("upstream_close_failed"));
        throw error;
      }
    }
    const recovering = state === "broken";
    let cleanupFailed = false;
    try {
      await endControlTurn("Interrupt");
    } catch {
      // The notification may fail when the runtime was killed or replaced.
      // Replacement is permitted only after owned-process teardown succeeds.
      cleanupFailed = true;
    }
    state = "broken";
    await closeUpstream();
    signal.throwIfAborted();
    upstream = factory();
    upstreamClose = undefined;
    sessionId = randomUUID();
    try {
      await upstream.connect();
      publicSurface(upstream);
      signal.throwIfAborted();
      const result = toolResult(
        await upstream.call("js_reset", args, {
          sessionId,
          turnId: randomUUID(),
          toolCallId: String(context.requestId),
          signal,
        }),
      );
      signal.throwIfAborted();
      if (result.isError) {
        await closeUpstream();
        return result;
      }
      state = "open";
      audit("runtime_replaced", { recovering, cleanup_failed: cleanupFailed });
      return {
        ...result,
        content: [
          ...result.content,
          {
            type: "text",
            text:
              "The owned LCU runtime was restarted and all JavaScript bindings were discarded. No previous action was replayed. Select and observe the target again before input." +
              (cleanupFailed || recovering
                ? " The earlier action's outcome may be uncertain; resetting does not undo its effects."
                : ""),
          },
        ],
      };
    } catch (error) {
      await closeUpstream().catch(() => audit("upstream_close_failed"));
      audit("runtime_reset_failed");
      throw error;
    }
  }

  async function call(
    name: string,
    args: Record<string, unknown>,
    context: { requestId: string | number; signal: AbortSignal },
  ): Promise<CallToolResult> {
    if (state !== "open" && !(state === "broken" && name === "js_reset"))
      return errorResult(
        "This LCU session is closed or its cleanup failed. Call js_reset to replace its runtime; reconnecting alone does not clear the logical context. Do not replay a possible desktop action.",
      );
    if (name !== "js" && name !== "js_reset")
      return errorResult("Host-only tools are not exposed.");
    const signal = AbortSignal.any([context.signal, stop.signal]);
    const work = queue
      .run(signal, async () => {
        if (state !== "open" && !(state === "broken" && name === "js_reset"))
          return errorResult("Session closed before execution; no action was started.");
        signal.throwIfAborted();
        // Explicit reset owns process replacement for stdio and HTTP alike. It
        // works even when reconnecting has retained a poisoned conversation.
        if (name === "js_reset") return resetRuntime(args, context, signal);
        const turnId = (controlTurn ??= { id: randomUUID() }).id;
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
            let turnNotificationFailed = false;
            try {
              await endControlTurn(hadInFlightCalls ? "Interrupt" : "Stop");
            } catch {
              turnNotificationFailed = true;
            }
            // The turn notification may fail after the host process is gone.
            // Confirmed process closure is sufficient to free the owned slot;
            // an unconfirmed close still throws and must quarantine the slot.
            await closeUpstream();
            if (turnNotificationFailed)
              audit("control_turn_notification_failed_after_confirmed_close");
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
        "\nLCU Auto: " +
        [
          "Native-app consent is handled locally.",
          "JavaScript REPL bindings and the Computer Use control turn persist only within the same logical execution context.",
          "With a stable X-OpenAI-Session header or openai/session metadata, short-lived HTTP clients can share a context under the same authenticated principal.",
          "For correlated HTTP clients, a missing execution context requires an explicit js_reset before the first js or after idle expiry.",
          "A retained stateful HTTP transport remains connected while its idle execution runtime may be reclaimed; the next js then returns LCU_CONTEXT_RESET_REQUIRED without running code.",
          "On LCU_CONTEXT_RESET_REQUIRED call js_reset, reacquire the app and observe the current UI. Do not automatically replay any earlier desktop action.",
          "Without a stable correlation identifier, each new MCP transport may use a fresh runtime; scheduled or background ChatGPT tasks may have this behavior.",
          "Do not assume JavaScript variables, app bindings or accessibility element indices survive separate js tool calls in that mode.",
          "Follow upstream LCU's first-call setup instructions; when continuing without confirmed context reuse, reacquire the target using cua.getApp(...) and observe its current UI state before acting within that js call.",
          "Batch related actions and verification into one js call when safe; if a previous action's outcome is uncertain, observe the real desktop and do not blindly replay side effects.",
          "Successful calls do not end a retained control turn, but a later call might use a different context.",
          "Cancellation ends the control turn.",
          "js_reset closes and replaces this context's LCU runtime without replaying previous actions; bindings are lost and the target must be observed again before input.",
          "Reconnecting alone does not repair a broken logical context.",
          "OS permission grants remain local and cannot be repaired by MCP reset.",
          "Contexts expire after inactivity and are lost on service restart.",
          "If an error mentions get_app_state, use app.getAXState() or cua.getApp(...) inside js; there is no separate get_app_state MCP tool.",
        ].join(" "),
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

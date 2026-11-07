import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  createExecution,
  UpstreamTeardownUnconfirmedError,
  type DesktopQueue,
  type Execution,
} from "./session.ts";
import { type Upstream, type Audit } from "./lcu.ts";

/** Correlation hints are not credentials. Namespace them inside a verified principal. */
export function conversationId(
  headers: Headers,
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const header = headers.get("x-openai-session") ?? undefined;
  const field = meta?.["openai/session"];
  for (const value of [header, field]) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.length < 1 ||
        value.length > 512 ||
        [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    ) {
      throw new Error("Invalid conversation correlation identifier.");
    }
  }
  if (header !== undefined && field !== undefined && header !== field) {
    throw new Error("Conflicting conversation correlation identifiers.");
  }
  return typeof field === "string" ? field : header;
}
export function contextKey(
  principal: string,
  kind: "conversation" | "transport",
  id: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([principal, kind, id]))
    .digest("hex");
}

export class ContextCapacityError extends Error {
  constructor() {
    super(
      "Computer-use context capacity reached. Existing active contexts were not evicted; retry after an idle context expires.",
    );
  }
}
type Entry = {
  execution: Promise<Execution>;
  calls: number;
  idleSince: number;
  principal: string;
  kind: "transport" | "conversation";
  generation: number;
  needsReset: boolean;
  phase: "creating" | "ready" | "retiring" | "quarantined";
  retirement?: Promise<void>;
};

export const RESET_REQUIRED = "LCU_CONTEXT_RESET_REQUIRED";
const resetRequired = (): CallToolResult => ({
  isError: true,
  content: [
    {
      type: "text",
      text: `${RESET_REQUIRED}: the JavaScript context is not initialized, is absent, or has expired. This code was not executed. Call js_reset, reacquire the app, and observe its UI before input. Do not replay an uncertain earlier action.`,
    },
  ],
});
const unavailable = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: message }],
});

/** Bound expensive runtimes, not discovery requests or disposable MCP connections. */
export class ExecutionContexts {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;
  private nextGeneration = 0;
  constructor(
    private readonly factory: () => Upstream,
    private readonly queue: DesktopQueue,
    private readonly audit: Audit,
    private readonly limit: number,
    private readonly idleMs: number,
    private readonly reclaimAtCapacity?: (principal: string) => Promise<void>,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get size() {
    return this.entries.size;
  }
  get activeCalls() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.calls, 0);
  }
  get snapshot() {
    const entries = [...this.entries.values()];
    const idle = entries.filter((entry) => entry.phase === "ready" && entry.calls === 0);
    return {
      executionContexts: entries.length,
      activeCalls: this.activeCalls,
      idleExecutionContexts: idle.length,
      closingExecutionContexts: entries.filter((entry) => entry.phase === "retiring").length,
      quarantinedExecutionContexts: entries.filter((entry) => entry.phase === "quarantined").length,
      oldestExecutionIdleMs: idle.length
        ? Math.max(0, Math.floor(this.now() - Math.min(...idle.map((entry) => entry.idleSince))))
        : null,
    };
  }
  isIdle(key: string) {
    const entry = this.entries.get(key);
    return entry?.phase === "ready" && entry.calls === 0;
  }
  oldestIdleTransport(principal: string, eligible: (key: string) => boolean = () => true) {
    const candidate = [...this.entries]
      .filter(
        ([key, entry]) =>
          eligible(key) &&
          entry.principal === principal &&
          entry.kind === "transport" &&
          entry.phase === "ready" &&
          entry.calls === 0,
      )
      .sort(([, a], [, b]) => a.idleSince - b.idleSince)[0];
    return candidate?.[0];
  }
  readonly call = async (
    key: string,
    principal: string,
    name: string,
    args: Record<string, unknown>,
    context: { requestId: string | number; signal: AbortSignal },
    permission: "first-use" | "retained" = "first-use",
    kind: "transport" | "conversation" = "transport",
  ): Promise<CallToolResult> => {
    if (this.stopped) throw new Error("Server is shutting down.");
    let entry = this.entries.get(key);
    if (entry?.phase === "retiring" || entry?.phase === "quarantined")
      return unavailable(
        "The owned LCU runtime is closing or its teardown was not confirmed. No new action was started. Do not retry until the broker is healthy.",
      );
    if (entry?.needsReset && name === "js") return resetRequired();
    // A correlated HTTP request has no bounded history that distinguishes its
    // first js from an old js after GC. Require explicit recovery for both.
    if (!entry && name === "js" && permission === "retained") return resetRequired();
    if (!entry) {
      // Capacity reclaim must preserve the transport and its recovery marker.
      if (this.entries.size >= this.limit) {
        await this.reclaimAtCapacity?.(principal);
        if (this.stopped) throw new Error("Server is shutting down.");
        entry = this.entries.get(key);
        if (entry?.phase === "retiring" || entry?.phase === "quarantined")
          return unavailable(
            "The owned LCU runtime is closing or quarantined. No action was started.",
          );
        if (entry?.needsReset && name === "js") return resetRequired();
      }
    }
    if (!entry) {
      if (this.entries.size >= this.limit) throw new ContextCapacityError();
      // Reserve synchronously before connecting so concurrent requests cannot exceed the limit.
      entry = {
        execution: createExecution(this.factory, this.queue, this.audit, {
          coldReset: name === "js_reset",
        }),
        calls: 0,
        idleSince: this.now(),
        principal,
        kind,
        generation: ++this.nextGeneration,
        needsReset: name === "js_reset",
        phase: "creating",
      };
      this.entries.set(key, entry);
      this.audit("execution_context_created", {
        context: key.slice(0, 12),
        contexts: this.entries.size,
        generation: entry.generation,
      });
    }
    const current = entry;
    current.calls++;
    try {
      let execution: Execution;
      try {
        execution = await current.execution;
      } catch (error) {
        if (this.entries.get(key) === current && current.phase !== "retiring") {
          if (error instanceof UpstreamTeardownUnconfirmedError) {
            current.phase = "quarantined";
            this.audit("execution_context_quarantined", {
              context: key.slice(0, 12),
              generation: current.generation,
            });
          } else this.entries.delete(key);
        }
        throw error;
      }
      if (current.phase === "creating") current.phase = "ready";
      if (current.phase !== "ready")
        return unavailable("This LCU context is retiring. No new action was started.");
      const result = await execution.call(name, args, context);
      if (name === "js_reset" && result.isError !== true) current.needsReset = false;
      return result;
    } finally {
      current.calls--;
      current.idleSince = this.now();
    }
  };
  close(
    key: string,
    reason: "idle" | "capacity" | "transport" | "shutdown" = "transport",
  ): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    if (entry.phase === "quarantined")
      return Promise.reject(new UpstreamTeardownUnconfirmedError());
    if (entry.retirement) return entry.retirement;
    // Keep the slot occupied until teardown finishes; do not overlap replacement runtimes.
    entry.phase = "retiring";
    entry.retirement = (async () => {
      try {
        let execution: Execution;
        try {
          execution = await entry.execution;
        } catch (error) {
          // Construction already closed its upstream unless it explicitly says otherwise.
          if (error instanceof UpstreamTeardownUnconfirmedError) throw error;
          if (this.entries.get(key) === entry) this.entries.delete(key);
          return;
        }
        await execution.close();
      } catch (error) {
        entry.phase = "quarantined";
        this.audit("execution_context_close_failed", { context: key.slice(0, 12) });
        // An unconfirmed teardown must not free a slot for another runtime.
        // Keep this context quarantined until the broker can be restarted.
        throw error;
      }
      if (this.entries.get(key) === entry) this.entries.delete(key);
      this.audit("execution_context_closed", {
        context: key.slice(0, 12),
        contexts: this.entries.size,
        reason,
        generation: entry.generation,
      });
    })();
    return entry.retirement;
  }
  async sweep() {
    const now = this.now();
    await Promise.allSettled(
      [...this.entries]
        .filter(
          ([, entry]) =>
            entry.phase === "ready" && entry.calls === 0 && now - entry.idleSince > this.idleMs,
        )
        .map(([key]) => this.close(key, "idle")),
    );
  }
  async shutdown() {
    this.stopped = true;
    const results = await Promise.allSettled(
      [...this.entries.keys()].map((key) => this.close(key, "shutdown")),
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Some LCU contexts could not be confirmed closed",
      );
  }
}

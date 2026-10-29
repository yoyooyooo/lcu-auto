import { createHash } from "node:crypto";
import { createExecution, type DesktopQueue, type Execution, type ToolCall } from "./session.ts";
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
  touched: number;
  closing: Promise<void> | undefined;
};

/** Bound expensive runtimes, not discovery requests or disposable MCP connections. */
export class ExecutionContexts {
  private readonly entries = new Map<string, Entry>();
  private stopped = false;
  constructor(
    private readonly factory: () => Upstream,
    private readonly queue: DesktopQueue,
    private readonly audit: Audit,
    private readonly limit: number,
    private readonly idleMs: number,
  ) {}

  get size() {
    return this.entries.size;
  }
  get activeCalls() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.calls, 0);
  }
  touch(key: string) {
    const entry = this.entries.get(key);
    if (entry) entry.touched = Date.now();
  }
  readonly call = async (key: string, ...args: Parameters<ToolCall>): ReturnType<ToolCall> => {
    if (this.stopped) throw new Error("Server is shutting down.");
    let entry = this.entries.get(key);
    if (entry?.closing)
      throw new Error("This context is closing. Observe the target after reconnecting.");
    if (!entry) {
      if (this.entries.size >= this.limit) throw new ContextCapacityError();
      // Reserve synchronously before connecting so concurrent requests cannot exceed the limit.
      entry = {
        execution: createExecution(this.factory, this.queue, this.audit),
        calls: 0,
        touched: Date.now(),
        closing: undefined,
      };
      this.entries.set(key, entry);
      this.audit("execution_context_created", {
        context: key.slice(0, 12),
        contexts: this.entries.size,
      });
    }
    const current = entry;
    current.calls++;
    try {
      let execution: Execution;
      try {
        execution = await current.execution;
      } catch (error) {
        if (this.entries.get(key) === current) this.entries.delete(key);
        throw error;
      }
      return await execution.call(...args);
    } finally {
      current.calls--;
      current.touched = Date.now();
    }
  };
  close(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    if (entry.closing) return entry.closing;
    // Keep the slot occupied until teardown finishes; do not overlap replacement runtimes.
    entry.closing = (async () => {
      try {
        await (await entry.execution).close();
      } catch {
        this.audit("execution_context_close_failed", { context: key.slice(0, 12) });
      } finally {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        this.audit("execution_context_closed", {
          context: key.slice(0, 12),
          contexts: this.entries.size,
        });
      }
    })();
    return entry.closing;
  }
  async sweep() {
    const now = Date.now();
    await Promise.all(
      [...this.entries]
        .filter(([, entry]) => !entry.calls && now - entry.touched > this.idleMs)
        .map(([key]) => this.close(key)),
    );
  }
  async shutdown() {
    this.stopped = true;
    await Promise.all([...this.entries.keys()].map((key) => this.close(key)));
  }
}

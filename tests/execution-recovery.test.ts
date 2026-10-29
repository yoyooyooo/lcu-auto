import { expect, test } from "bun:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createExecution, DesktopQueue } from "../src/session.ts";
import type { Upstream } from "../src/lcu.ts";

function fixture(options: { rejectClose?: boolean; rejectConnectAt?: number } = {}) {
  let generations = 0;
  let effects = 0;
  const events: string[] = [];
  const factory = (): Upstream => {
    const generation = ++generations;
    events.push(`create:${generation}`);
    let counter = 0;
    let disconnected = false;
    let closed = false;
    return {
      instructions: "Synthetic recovery fixture",
      async connect() {
        events.push(`connect:${generation}`);
        if (options.rejectConnectAt === generation) throw new Error("Fixture connection failed");
      },
      publicTools: () =>
        ["js", "js_reset"].map((name) => ({ name, inputSchema: { type: "object" } })),
      async call(name, args, context) {
        if (closed) throw new Error("Fixture client is closed");
        if (name === "js_reset") counter = 0;
        if (args.code === "disconnect-after-effect") {
          effects++;
          disconnected = true;
          throw new Error("Runtime connection closed after an uncertain desktop effect");
        }
        if (args.code === "increment") {
          effects++;
          counter++;
        }
        events.push(`call:${generation}:${name}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ generation, counter, session: context.sessionId }),
            },
          ],
        };
      },
      async turnEnded() {
        events.push(`end:${generation}`);
        if (disconnected) throw new Error("Fixture turn notification failed");
      },
      async close() {
        events.push(`close:${generation}`);
        if (options.rejectClose && generation === 1)
          throw new Error("Fixture teardown not confirmed");
        closed = true;
      },
    };
  };
  return {
    factory,
    events,
    get generations() {
      return generations;
    },
    get effects() {
      return effects;
    },
  };
}
const context = () => ({ requestId: "test", signal: new AbortController().signal });
const data = (result: CallToolResult) => {
  const text = result.content.find((block) => block.type === "text");
  if (!text || text.type !== "text") throw new Error("Expected fixture response");
  return JSON.parse(text.text);
};

test("explicit reset recovers a broken runtime without replaying its uncertain action", async () => {
  const f = fixture();
  const execution = await createExecution(f.factory, new DesktopQueue(), () => {});
  try {
    expect(
      (await execution.call("js", { code: "disconnect-after-effect" }, context())).isError,
    ).toBe(true);
    expect((await execution.call("js", { code: "increment" }, context())).isError).toBe(true);
    expect(f.effects).toBe(1);
    const reset = await execution.call("js_reset", {}, context());
    expect(reset.isError).not.toBe(true);
    expect(f.generations).toBe(2);
    expect(data(await execution.call("js", { code: "read" }, context())).counter).toBe(0);
    expect(f.effects).toBe(1);
    expect(f.events.indexOf("close:1")).toBeLessThan(f.events.indexOf("create:2"));
  } finally {
    await execution.close();
  }
});

test("healthy reset replaces the runtime process and session identity, not only its REPL", async () => {
  const f = fixture();
  const execution = await createExecution(f.factory, new DesktopQueue(), () => {});
  try {
    const before = data(await execution.call("js", { code: "increment" }, context()));
    expect((await execution.call("js_reset", {}, context())).isError).not.toBe(true);
    const after = data(await execution.call("js", { code: "read" }, context()));
    expect(after.generation).toBe(2);
    expect(after.session).not.toBe(before.session);
    expect(after.counter).toBe(0);
    expect(f.events.filter((event) => event === "end:1")).toHaveLength(1);
  } finally {
    await execution.close();
  }
});

test("unconfirmed teardown stays fail-closed even when reset is repeated", async () => {
  const f = fixture({ rejectClose: true });
  const execution = await createExecution(f.factory, new DesktopQueue(), () => {});
  try {
    await execution.call("js", { code: "disconnect-after-effect" }, context());
    expect((await execution.call("js_reset", {}, context())).isError).toBe(true);
    expect((await execution.call("js_reset", {}, context())).isError).toBe(true);
    expect(f.generations).toBe(1);
    expect(f.events.filter((event) => event === "close:1")).toHaveLength(1);
    expect((await execution.call("js", { code: "increment" }, context())).isError).toBe(true);
    expect(f.effects).toBe(1);
  } finally {
    await execution.close().catch(() => {});
  }
});

test("failed replacement is retired and a later explicit reset can try a fresh runtime", async () => {
  const f = fixture({ rejectConnectAt: 2 });
  const execution = await createExecution(f.factory, new DesktopQueue(), () => {});
  try {
    expect((await execution.call("js_reset", {}, context())).isError).toBe(true);
    expect(f.events).toContain("close:2");
    expect((await execution.call("js", { code: "increment" }, context())).isError).toBe(true);
    expect((await execution.call("js_reset", {}, context())).isError).not.toBe(true);
    expect(data(await execution.call("js", { code: "read" }, context())).generation).toBe(3);
    expect(f.effects).toBe(0);
  } finally {
    await execution.close();
  }
});

test("cancelled reset and reset after shutdown never create a replacement", async () => {
  const f = fixture();
  const execution = await createExecution(f.factory, new DesktopQueue(), () => {});
  const abort = new AbortController();
  abort.abort();
  expect(
    (await execution.call("js_reset", {}, { requestId: "cancelled", signal: abort.signal }))
      .isError,
  ).toBe(true);
  expect(f.generations).toBe(1);
  await execution.close();
  expect((await execution.call("js_reset", {}, context())).isError).toBe(true);
  expect(f.generations).toBe(1);
});

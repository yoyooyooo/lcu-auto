import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Upstream } from "../src/lcu.ts";
import { startHttp } from "../src/http.ts";
import { ExecutionContexts } from "../src/contexts.ts";
import { DesktopQueue } from "../src/session.ts";

const token = "synthetic-idle-gc-testing-only-token-is-not-private";

function fakeRuntime() {
  const events: string[] = [];
  let effects = 0;
  let generations = 0;
  const factory = (): Upstream => {
    const generation = ++generations;
    return {
      instructions: "Synthetic GC test, never controls the desktop",
      async connect() {
        events.push(`connect:${generation}`);
      },
      publicTools: () =>
        ["js", "js_reset"].map((name) => ({ name, inputSchema: { type: "object" } })),
      async call(name) {
        if (name === "js") effects++;
        events.push(`call:${generation}:${name}`);
        return { content: [{ type: "text", text: `generation=${generation}` }] };
      },
      async turnEnded() {
        events.push(`turn-ended:${generation}`);
      },
      async close() {
        events.push(`close:${generation}`);
      },
    };
  };
  return {
    factory,
    events,
    get effects() {
      return effects;
    },
    get generations() {
      return generations;
    },
  };
}

const callContext = () => ({ requestId: "synthetic-call", signal: new AbortController().signal });

test("regular MCP heartbeats keep a healthy transport, not an idle desktop runtime", async () => {
  const fake = fakeRuntime();
  const server = await startHttp(
    fake.factory,
    { token, port: 0, publicOrigins: [], idleMs: 200 },
    () => {},
  );
  const client = new Client({ name: "heartbeat-test", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    expect((await client.callTool({ name: "js", arguments: {} })).isError).not.toBe(true);
    expect(server.contextCount).toBe(1);
    const started = Date.now();
    while (Date.now() - started < 700) {
      await client.ping();
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(server.contextCount).toBe(0);
    expect(server.sessionCount).toBe(1);
    expect(fake.effects).toBe(1);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
    await server.close();
  }
}, 10_000);

test("an expired logical context must reject an old js, without allocating or executing", async () => {
  const fake = fakeRuntime();
  let now = 1000;
  const contexts = new ExecutionContexts(
    fake.factory,
    new DesktopQueue(),
    () => {},
    1,
    600_000,
    undefined,
    () => now,
  );
  try {
    expect((await contexts.call("one", "owner", "js", {}, callContext())).isError).not.toBe(true);
    now += 600_001;
    await contexts.sweep();
    expect(contexts.size).toBe(0);
    const result = await contexts.call("one", "owner", "js", {}, callContext(), "retained");
    expect(result.isError).toBe(true);
    expect(
      result.content.some(
        (item) => item.type === "text" && item.text.includes("LCU_CONTEXT_RESET_REQUIRED"),
      ),
    ).toBe(true);
    expect(fake.effects).toBe(1);
    expect(contexts.size).toBe(0);
  } finally {
    await contexts.shutdown();
  }
});

test("sweep leaves a healthy stateful MCP transport usable and requires one cold reset generation", async () => {
  let now = 1_000;
  const fake = fakeRuntime();
  const server = await startHttp(
    fake.factory,
    {
      token,
      port: 0,
      publicOrigins: [],
      idleMs: 500,
      now: () => now,
    },
    () => {},
  );
  const client = new Client({ name: "virtual-clock-sweep", version: "1" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
    await client.callTool({ name: "js", arguments: {} });
    expect(server.contextCount).toBe(1);
    const before = fake.generations;
    now += 501;
    await client.ping();
    await server.sweep();
    expect(server.sessionCount).toBe(1);
    expect(server.contextCount).toBe(0);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["js", "js_reset"]);
    const rejected = CallToolResultSchema.parse(
      await client.callTool({ name: "js", arguments: {} }),
    );
    expect(rejected.isError).toBe(true);
    expect(
      rejected.content.some(
        (block) => block.type === "text" && block.text.includes("LCU_CONTEXT_RESET_REQUIRED"),
      ),
    ).toBe(true);
    expect(fake.effects).toBe(1);
    expect(fake.generations).toBe(before);
    const reset = await client.callTool({ name: "js_reset", arguments: {} });
    expect(reset.isError).not.toBe(true);
    expect(fake.generations).toBe(before + 1);
    expect((await client.callTool({ name: "js", arguments: {} })).isError).not.toBe(true);
    expect(fake.effects).toBe(2);
    expect(server.contextCount).toBe(1);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close();
    await server.close();
  }
}, 10_000);

test("expired execution refuses a racing js while teardown is awaiting confirmation", async () => {
  let now = 1_000;
  const events: string[] = [];
  let releaseClose = () => {};
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const fake = fakeRuntime();
  const contexts = new ExecutionContexts(
    () => {
      const upstream = fake.factory();
      return {
        ...upstream,
        async close() {
          events.push("closing");
          await closeGate;
          events.push("closed");
        },
      };
    },
    new DesktopQueue(),
    () => {},
    1,
    500,
    undefined,
    () => now,
  );
  try {
    await contexts.call("a", "owner", "js", {}, callContext());
    now += 501;
    const cleanup = contexts.sweep();
    expect(contexts.snapshot.closingExecutionContexts).toBe(1);
    const rejected = await contexts.call("a", "owner", "js", {}, callContext(), "retained");
    expect(rejected.isError).toBe(true);
    expect(fake.effects).toBe(1);
    expect(contexts.size).toBe(1);
    releaseClose();
    await cleanup;
    expect(contexts.size).toBe(0);
    expect(events).toEqual(["closing", "closed"]);
  } finally {
    releaseClose();
    await contexts.shutdown();
  }
});

test("unknown teardown after startup failure is quarantined and never frees capacity", async () => {
  let attempted = 0;
  const contexts = new ExecutionContexts(
    () => ({
      instructions: "synthetic startup failure",
      publicTools: () => [],
      async connect() {
        attempted++;
        throw new Error("connect failed");
      },
      async close() {
        throw new Error("close not confirmed");
      },
      async call() {
        throw new Error("never called");
      },
      async turnEnded() {},
    }),
    new DesktopQueue(),
    () => {},
    1,
    500,
  );
  await expect(contexts.call("a", "owner", "js", {}, callContext())).rejects.toThrow("quarantined");
  expect(contexts.snapshot.quarantinedExecutionContexts).toBe(1);
  expect(contexts.size).toBe(1);
  await expect(contexts.call("b", "owner", "js", {}, callContext())).rejects.toThrow(
    "capacity reached",
  );
  expect(attempted).toBe(1);
  await expect(contexts.shutdown()).rejects.toThrow("confirmed closed");
});

test("failed turn notification with confirmed process closure frees the runtime slot", async () => {
  const fake = fakeRuntime();
  let closed = 0;
  const audits: string[] = [];
  const contexts = new ExecutionContexts(
    () => {
      const upstream = fake.factory();
      return {
        ...upstream,
        async turnEnded() {
          throw new Error("turn notification failed after process exited");
        },
        async close() {
          closed++;
        },
      };
    },
    new DesktopQueue(),
    (event) => audits.push(event),
    1,
    500,
  );
  await contexts.call("a", "owner", "js", {}, callContext());
  await contexts.close("a", "idle");
  expect(closed).toBe(1);
  expect(contexts.size).toBe(0);
  expect(contexts.snapshot.quarantinedExecutionContexts).toBe(0);
  expect(audits).toContain("control_turn_notification_failed_after_confirmed_close");
  await contexts.shutdown();
});

test("shutdown during capacity reclaim rejects the pending new generation", async () => {
  const fake = fakeRuntime();
  let enteredReclaim = () => {};
  let allowReclaim = () => {};
  const reached = new Promise<void>((resolve) => {
    enteredReclaim = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    allowReclaim = resolve;
  });
  const contexts = new ExecutionContexts(
    fake.factory,
    new DesktopQueue(),
    () => {},
    1,
    500,
    async () => {
      enteredReclaim();
      await gate;
    },
  );
  await contexts.call("a", "owner", "js", {}, callContext());
  const pending = contexts.call("b", "owner", "js", {}, callContext());
  await reached;
  await contexts.shutdown();
  allowReclaim();
  await expect(pending).rejects.toThrow("shutting down");
  expect(fake.effects).toBe(1);
  expect(contexts.size).toBe(0);
});

test("100 cold-reset and idle-retire cycles keep state bounded with one close per generation", async () => {
  let now = 1_000;
  const fake = fakeRuntime();
  const contexts = new ExecutionContexts(
    fake.factory,
    new DesktopQueue(),
    () => {},
    1,
    100,
    undefined,
    () => now,
  );
  for (let n = 0; n < 100; n++) {
    const reset = await contexts.call(
      "stable",
      "owner",
      "js_reset",
      {},
      callContext(),
      "retained",
      "conversation",
    );
    expect(reset.isError).not.toBe(true);
    expect(contexts.size).toBe(1);
    now += 101;
    await contexts.sweep();
    expect(contexts.size).toBe(0);
  }
  expect(fake.generations).toBe(100);
  expect(fake.events.filter((event) => event.startsWith("close:"))).toHaveLength(100);
  expect(contexts.snapshot.quarantinedExecutionContexts).toBe(0);
  await contexts.shutdown();
});

test("concurrent correlated js cannot slip past a cold reset that is still running", async () => {
  let startedReset = () => {};
  let finishReset = () => {};
  const started = new Promise<void>((resolve) => {
    startedReset = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finishReset = resolve;
  });
  const fake = fakeRuntime();
  const contexts = new ExecutionContexts(
    () => {
      const runtime = fake.factory();
      return {
        ...runtime,
        async call(name, args, meta) {
          if (name === "js_reset") {
            startedReset();
            await gate;
          }
          return runtime.call(name, args, meta);
        },
      };
    },
    new DesktopQueue(),
    () => {},
    2,
    500,
  );
  try {
    const resetting = contexts.call(
      "conversation",
      "owner",
      "js_reset",
      {},
      callContext(),
      "retained",
      "conversation",
    );
    await started;
    expect(contexts.size).toBe(1);
    const tooEarly = await contexts.call(
      "conversation",
      "owner",
      "js",
      {},
      callContext(),
      "retained",
      "conversation",
    );
    expect(tooEarly.isError).toBe(true);
    expect(fake.effects).toBe(0);
    finishReset();
    expect((await resetting).isError).not.toBe(true);
    expect(fake.generations).toBe(1);
    expect(
      (
        await contexts.call(
          "conversation",
          "owner",
          "js",
          {},
          callContext(),
          "retained",
          "conversation",
        )
      ).isError,
    ).not.toBe(true);
    expect(fake.effects).toBe(1);
  } finally {
    finishReset();
    await contexts.shutdown();
  }
});

test("HTTP correlated context expiry blocks old code across fresh transports until explicit reset", async () => {
  let now = 10_000;
  const fake = fakeRuntime();
  const server = await startHttp(
    fake.factory,
    { token, port: 0, publicOrigins: [], idleMs: 500, now: () => now },
    () => {},
  );
  async function client() {
    const c = new Client({ name: "correlated-expiry-probe", version: "1" }, { capabilities: {} });
    const t = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}`, "x-openai-session": "same-conversation" },
      },
    });
    await c.connect(t);
    return {
      c,
      async close() {
        await c.close();
      },
    };
  }
  try {
    const a = await client();
    const first = CallToolResultSchema.parse(await a.c.callTool({ name: "js", arguments: {} }));
    expect(first.isError).toBe(true);
    expect(fake.effects).toBe(0);
    expect((await a.c.callTool({ name: "js_reset", arguments: {} })).isError).not.toBe(true);
    expect((await a.c.callTool({ name: "js", arguments: {} })).isError).not.toBe(true);
    await a.close();
    const before = fake.generations;
    now += 501;
    await server.sweep();
    expect(server.contextCount).toBe(0);
    const b = await client();
    try {
      const old = CallToolResultSchema.parse(await b.c.callTool({ name: "js", arguments: {} }));
      expect(old.isError).toBe(true);
      expect(
        old.content.some(
          (item) => item.type === "text" && item.text.includes("LCU_CONTEXT_RESET_REQUIRED"),
        ),
      ).toBe(true);
      expect(fake.generations).toBe(before);
      expect(fake.effects).toBe(1);
      expect((await b.c.callTool({ name: "js_reset", arguments: {} })).isError).not.toBe(true);
      expect(fake.generations).toBe(before + 1);
      expect((await b.c.callTool({ name: "js", arguments: {} })).isError).not.toBe(true);
    } finally {
      await b.close();
    }
  } finally {
    await server.close();
  }
}, 10_000);

test("health reports resource counts separately and authenticated probes never renew execution activity", async () => {
  let now = 1_000;
  const fake = fakeRuntime();
  const server = await startHttp(
    fake.factory,
    { token, port: 0, publicOrigins: [], idleMs: 500, now: () => now },
    () => {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const c = new Client({ name: "metrics-probe", version: "1" }, { capabilities: {} });
  const health = () =>
    fetch(new URL("/healthz", server.url), {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json());
  try {
    await c.connect(transport);
    await c.callTool({ name: "js", arguments: {} });
    const before = await health();
    expect(before.version).toBe("0.5.0");
    expect(before.transports).toBe(1);
    expect(before.connectedTransports).toBe(1);
    expect(before.executionContexts).toBe(1);
    expect(before.idleExecutionContexts).toBe(1);
    expect(before.oldestExecutionIdleMs).toBe(0);
    now += 501;
    await health();
    await c.ping();
    await server.sweep();
    const after = await health();
    expect(after.sessions).toBe(1);
    expect(after.transports).toBe(1);
    expect(after.executionContexts).toBe(0);
    expect(after.oldestExecutionIdleMs).toBeNull();
    expect(after.activeCalls).toBe(0);
    expect(after.quarantinedExecutionContexts).toBe(0);
  } finally {
    await transport.terminateSession().catch(() => {});
    await c.close();
    await server.close();
  }
}, 10_000);

test("failed discovery teardown cannot spawn repeated untracked upstream processes", async () => {
  let created = 0;
  const server = await startHttp(
    () => {
      created++;
      return {
        instructions: "Synthetic discovery with failed teardown",
        async connect() {},
        publicTools: () =>
          ["js", "js_reset"].map((name) => ({ name, inputSchema: { type: "object" } })),
        async call() {
          throw new Error("no calls expected");
        },
        async turnEnded() {},
        async close() {
          throw new Error("failed to stop discovery process");
        },
      };
    },
    { token, port: 0, publicOrigins: [] },
    () => {},
  );
  const initialize = () =>
    fetch(server.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      }),
    });
  for (let n = 0; n < 5; n++) expect((await initialize()).status).toBe(503);
  expect(created).toBe(1);
  const snapshot = await fetch(new URL("/healthz", server.url), {
    headers: { Authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  expect(snapshot.quarantinedDiscoveryProbes).toBe(1);
  await expect(server.close()).rejects.toThrow("unconfirmed cleanup");
});

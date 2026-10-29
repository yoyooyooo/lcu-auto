import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { defaultPrefix } from "../src/lcu.ts";
import { upstreamFactory } from "./support/upstream.ts";
import { startHttp } from "../src/http.ts";

const token = "contract-test-only-not-a-production-secret";
const silent = () => {};
async function scratch() {
  await mkdir(".runs", { recursive: true });
  return mkdtemp(resolve(".runs/contract-"));
}
function client() {
  return new Client({ name: "approval-less-client", version: "1" }, { capabilities: {} });
}
async function invoke(c: Client, code: string) {
  return CallToolResultSchema.parse(await c.callTool({ name: "js", arguments: { code } }));
}
function firstText(result: Awaited<ReturnType<typeof invoke>>) {
  const item = result.content.find((block) => block.type === "text");
  if (!item || item.type !== "text") throw new Error("Expected text result");
  return item.text;
}
async function fixtureHttp(options: { idleMs?: number; maxSessions?: number } = {}) {
  const directory = await scratch();
  const trace = resolve(directory, "trace.jsonl");
  const factory = await upstreamFactory(
    { prefix: defaultPrefix, scope: "always", origins: [], chrome: false },
    silent,
    [process.execPath, resolve("tests/fixture-mcp.ts"), trace],
  );
  const http = await startHttp(factory, { token, port: 0, publicOrigins: [], ...options }, silent);
  const peers: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
  return {
    http,
    trace,
    async connect() {
      const c = client();
      const transport = new StreamableHTTPClientTransport(new URL(http.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      peers.push({ client: c, transport });
      await c.connect(transport);
      return { client: c, transport };
    },
    async close() {
      await Promise.allSettled(
        peers.map(async (peer) => {
          await peer.transport.terminateSession().catch(() => {});
          await peer.client.close();
        }),
      );
      await http.close();
    },
  };
}

test("real stdio MCP with a deterministic upstream, client without elicitation", async () => {
  const dir = await scratch();
  const trace = resolve(dir, "trace.jsonl");
  const c = client();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("tests/stdio-gateway.ts"), trace],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await c.connect(transport);
    const tools = await c.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["js", "js_reset"]);
    expect(tools.tools[0]?.description).toBe("original:js");
    expect(tools.tools[0]?.annotations?.readOnlyHint).toBe(false);
    expect(tools.tools[0]?.annotations?.destructiveHint).toBe(true);
    expect(c.getInstructions()).toContain("Original fixture instructions must survive.");
    expect(JSON.parse(firstText(await invoke(c, "approve")))).toEqual({
      action: "accept",
      content: {},
      _meta: { persist: "always" },
    });
    expect(JSON.parse(firstText(await invoke(c, "session")))._meta.persist).toBe("session");
    expect(JSON.parse(firstText(await invoke(c, "once")))).toEqual({
      action: "accept",
      content: {},
    });
    expect(JSON.parse(firstText(await invoke(c, "unknown"))).action).toBe("cancel");
    await invoke(c, "observe");
    expect(JSON.parse(firstText(await invoke(c, "action"))).actionExecuted).toBe(true);
    await invoke(c, "set");
    expect(JSON.parse(firstText(await invoke(c, "get"))).memory).toBe(42);
    const image = await invoke(c, "image");
    expect(image.content).toEqual([
      { type: "text", text: "original image" },
      {
        type: "image",
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZsAAAAASUVORK5CYII=",
      },
    ]);
    expect(await invoke(c, "error")).toEqual({
      isError: true,
      content: [{ type: "text", text: "original tool error" }],
    });
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "turn_ended").length).toBe(0);
    await c.close();
    const closedEvents = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(closedEvents.filter((event) => event.event === "turn_ended").length).toBe(1);
    expect(
      closedEvents
        .filter((event) => event.event === "turn_ended")
        .every((event) => event.hook_event_name === "Stop"),
    ).toBe(true);
  } finally {
    await c.close();
  }
}, 30_000);

test("HTTP authenticates every request and rejects browser/DNS-rebinding requests", async () => {
  const f = await fixtureHttp();
  try {
    expect((await fetch(f.http.url)).status).toBe(401);
    expect((await fetch(f.http.url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(
      401,
    );
    expect(
      (
        await fetch(f.http.url, {
          headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(f.http.url, {
          headers: { Authorization: `Bearer ${token}`, Host: "evil.example" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(f.http.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(f.http.sessionCount).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test("HTTP sessions isolate REPL state, filter metadata and cleanly DELETE", async () => {
  const f = await fixtureHttp();
  try {
    const a = await f.connect();
    const b = await f.connect();
    await invoke(a.client, "set");
    expect(JSON.parse(firstText(await invoke(b.client, "get"))).memory).toBe(0);
    expect(JSON.parse(firstText(await invoke(a.client, "get"))).memory).toBe(42);
    const raw = await a.client.callTool({
      name: "js",
      arguments: { code: "meta" },
      _meta: { "codex/sandbox-state-meta": { permissionProfile: { type: "disabled" } } },
    });
    expect(firstText(CallToolResultSchema.parse(raw))).not.toContain("sandbox-state-meta");
    await a.transport.terminateSession();
    expect(f.http.sessionCount).toBe(1);
    await b.transport.terminateSession();
    expect(f.http.sessionCount).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

test("explicit reset replaces a cleanup-failed runtime without retrying its side effect", async () => {
  const f = await fixtureHttp();
  try {
    const peer = await f.connect();
    expect((await invoke(peer.client, "fail-cleanup")).isError).not.toBe(true);
    const reset = CallToolResultSchema.parse(
      await peer.client.callTool({ name: "js_reset", arguments: {} }),
    );
    expect(reset.isError).not.toBe(true);
    expect(
      reset.content.some(
        (block) => block.type === "text" && block.text.includes("outcome may be uncertain"),
      ),
    ).toBe(true);
    expect(JSON.parse(firstText(await invoke(peer.client, "get"))).memory).toBe(0);
    const events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.filter((event) => event.event === "call" && event.code === "fail-cleanup"),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
}, 30_000);

test("cancellation reaches upstream and Interrupt cleanup precedes the next operation", async () => {
  const f = await fixtureHttp();
  try {
    const peer = await f.connect();
    const abort = new AbortController();
    const pending = peer.client.callTool({ name: "js", arguments: { code: "slow" } }, undefined, {
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    abort.abort();
    await expect(pending).rejects.toThrow();
    await invoke(peer.client, "get");
    const events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const interruption = events.findIndex(
      (event) => event.event === "turn_ended" && event.hook_event_name === "Interrupt",
    );
    const nextCall = events.findIndex((event) => event.event === "call" && event.code === "get");
    expect(interruption).toBeGreaterThanOrEqual(0);
    expect(nextCall).toBeGreaterThan(interruption);
    const oldCall = events.find((event) => event.event === "call" && event.code === "slow");
    const next = events[nextCall];
    expect(next.meta["x-codex-turn-metadata"].turn_id).not.toBe(
      oldCall.meta["x-codex-turn-metadata"].turn_id,
    );
    expect((await invoke(peer.client, "action")).isError).toBe(true);
    await invoke(peer.client, "observe");
    expect((await invoke(peer.client, "action")).isError).not.toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);

test("idle HTTP sessions expire and concurrent session count is bounded", async () => {
  const f = await fixtureHttp({ idleMs: 150, maxSessions: 1 });
  try {
    const a = await f.connect();
    const b = await f.connect();
    expect(f.http.contextCount).toBe(0);
    await invoke(a.client, "set");
    expect(f.http.contextCount).toBe(1);
    await expect(invoke(b.client, "set")).rejects.toThrow();
    expect(JSON.parse(firstText(await invoke(a.client, "get"))).memory).toBe(42);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(f.http.sessionCount).toBe(0);
    const fresh = await f.connect();
    expect((await fresh.client.listTools()).tools.length).toBe(2);
  } finally {
    await f.close();
  }
}, 30_000);

test("HTTP shutdown waits for initialization and closes its late upstream", async () => {
  let started = () => {};
  let release = () => {};
  const connecting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const continueConnect = new Promise<void>((resolve) => {
    release = resolve;
  });
  let upstreamClosed = false;
  const http = await startHttp(
    () => ({
      async connect() {
        started();
        await continueConnect;
      },
      instructions: "test",
      publicTools() {
        return ["js", "js_reset"].map((name) => ({ name, inputSchema: { type: "object" } }));
      },
      async call() {
        return { content: [] };
      },
      async turnEnded() {},
      async close() {
        upstreamClosed = true;
      },
    }),
    { port: 0, token, publicOrigins: [] },
    silent,
  );
  const initializing = fetch(http.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  }).catch(() => undefined);
  try {
    await connecting;
    let finished = false;
    const shutdown = http.close().then(() => {
      finished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    expect(upstreamClosed).toBe(false);
    release();
    await shutdown;
    expect(upstreamClosed).toBe(true);
    expect(http.sessionCount).toBe(0);
    await initializing;
  } finally {
    release();
    await http.close();
  }
}, 10_000);

test("separate observation and input keep one control turn until reset or disconnect", async () => {
  const f = await fixtureHttp();
  try {
    const peer = await f.connect();
    expect((await invoke(peer.client, "action")).isError).toBe(true);
    await invoke(peer.client, "observe");
    expect(JSON.parse(firstText(await invoke(peer.client, "action"))).actionExecuted).toBe(true);
    expect((await invoke(peer.client, "error")).isError).toBe(true);
    expect(JSON.parse(firstText(await invoke(peer.client, "action"))).actionExecuted).toBe(true);
    let events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "turn_ended")).toHaveLength(0);
    const ids = events
      .filter((event) => event.event === "call")
      .map((event) => event.meta["x-codex-turn-metadata"].turn_id);
    expect(new Set(ids).size).toBe(1);
    const reset = CallToolResultSchema.parse(
      await peer.client.callTool({ name: "js_reset", arguments: {} }),
    );
    expect(reset.isError).not.toBe(true);
    expect((await invoke(peer.client, "action")).isError).toBe(true);
    await invoke(peer.client, "observe");
    expect((await invoke(peer.client, "action")).isError).not.toBe(true);
    await peer.transport.terminateSession();
    events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ends = events.filter((event) => event.event === "turn_ended");
    expect(ends.map((event) => event.hook_event_name)).toEqual(["Interrupt", "Stop"]);
    expect(ends[0].turn_id).toBe(ids[0]);
    expect(ends[1].turn_id).not.toBe(ids[0]);
  } finally {
    await f.close();
  }
}, 30_000);

test("HTTP idle expiry ends an observed control turn before closing its upstream", async () => {
  const f = await fixtureHttp({ idleMs: 150 });
  try {
    const peer = await f.connect();
    await invoke(peer.client, "observe");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(f.http.sessionCount).toBe(0);
    const events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ends = events.filter((event) => event.event === "turn_ended");
    expect(ends).toHaveLength(1);
    expect(ends[0].hook_event_name).toBe("Stop");
  } finally {
    await f.close();
  }
}, 30_000);

test("local stdio bridge uses the shared broker and cleans up its remote session on EOF", async () => {
  const f = await fixtureHttp();
  const dir = await scratch();
  const tokenFile = resolve(dir, "local.token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  const c = client();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("src/cli.ts"), "connect", "--url", f.http.url, "--token-file", tokenFile],
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  try {
    await c.connect(transport);
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(["js", "js_reset"]);
    expect(f.http.sessionCount).toBe(1);
    expect(JSON.parse(firstText(await invoke(c, "observe"))).active).toBe(true);
    expect((await invoke(c, "action")).isError).not.toBe(true);
    await c.close();
    expect(f.http.sessionCount).toBe(0);
  } finally {
    await c.close();
    await f.close();
  }
}, 30_000);

test("an authenticated principal cannot reuse another principal's MCP session", async () => {
  const directory = await scratch();
  const factory = await upstreamFactory(
    { prefix: defaultPrefix, scope: "always", origins: [], chrome: false },
    silent,
    [process.execPath, resolve("tests/fixture-mcp.ts"), resolve(directory, "trace.jsonl")],
  );
  const http = await startHttp(
    factory,
    { token, port: 0, publicOrigins: [] },
    silent,
    async (request) => request.headers.get("x-test-principal") ?? undefined,
  );
  const c = client();
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    requestInit: { headers: { "x-test-principal": "owner-a" } },
  });
  try {
    await c.connect(transport);
    const response = await fetch(http.url, {
      method: "DELETE",
      headers: {
        "x-test-principal": "owner-b",
        "mcp-session-id": transport.sessionId ?? "",
        "MCP-Protocol-Version": "2025-03-26",
      },
    });
    expect(response.status).toBe(404);
    expect(http.sessionCount).toBe(1);
    expect((await c.listTools()).tools.length).toBe(2);
  } finally {
    await transport.terminateSession().catch(() => {});
    await c.close();
    await http.close();
  }
}, 30_000);

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { startHttp } from "../src/http.ts";
import { defaultPrefix } from "../src/lcu.ts";
import { upstreamFactory } from "./support/upstream.ts";
import { conversationId } from "../src/contexts.ts";
import { authenticator, decodeAccessConfig, AuthUnavailableError } from "../src/auth.ts";

const token = "test-only-token-with-at-least-thirty-two-characters";
const silent = () => {};
async function setup(options: { limit?: number; idleMs?: number } = {}) {
  await mkdir(".runs", { recursive: true });
  const dir = await mkdtemp(resolve(".runs/chatgpt-contract-"));
  const trace = resolve(dir, "trace.jsonl");
  const realFactory = await upstreamFactory(
    { prefix: defaultPrefix, scope: "always", origins: [], chrome: false },
    silent,
    [process.execPath, resolve("tests/fixture-mcp.ts"), trace],
  );
  let created = 0;
  const http = await startHttp(
    () => {
      created++;
      return realFactory();
    },
    {
      port: 0,
      token,
      publicOrigins: [],
      maxSessions: options.limit ?? 8,
      idleMs: options.idleMs ?? 600_000,
    },
    silent,
    async (request) => request.headers.get("x-test-owner") ?? "owner-a",
  );
  async function connect(conversation?: string, owner = "owner-a") {
    const client = new Client(
      { name: "openai-short-lived-client-fixture", version: "1" },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: {
        headers: {
          "x-test-owner": owner,
          ...(conversation === undefined ? {} : { "x-openai-session": conversation }),
        },
      },
    });
    await client.connect(transport);
    return {
      client,
      transport,
      async close() {
        if (transport.sessionId) await transport.terminateSession().catch(() => {});
        await client.close();
      },
    };
  }
  return {
    http,
    connect,
    trace,
    get created() {
      return created;
    },
  };
}
async function run(c: Client, code: string, conversation?: string) {
  const result = CallToolResultSchema.parse(
    await c.callTool({
      name: "js",
      arguments: { code },
      ...(conversation === undefined ? {} : { _meta: { "openai/session": conversation } }),
    }),
  );
  if (result.isError)
    throw new Error(
      result.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n"),
    );
  const first = result.content.find((b) => b.type === "text");
  if (!first || first.type !== "text") throw new Error("Missing fixture text");
  return JSON.parse(first.text);
}

test("32 parallel ChatGPT discoveries use one temporary schema probe and no execution slots", async () => {
  const f = await setup({ limit: 1 });
  try {
    await Promise.all(
      Array.from({ length: 32 }, async () => {
        const peer = await f.connect("same-discovery-conversation");
        try {
          expect(peer.transport.sessionId).toBeUndefined();
          expect((await peer.client.listTools()).tools.map((t) => t.name)).toEqual([
            "js",
            "js_reset",
          ]);
        } finally {
          await peer.close();
        }
      }),
    );
    expect(f.created).toBe(1);
    expect(f.http.contextCount).toBe(0);
    expect(f.http.sessionCount).toBe(0);
  } finally {
    await f.http.close();
  }
}, 30_000);

test("12 fresh ChatGPT connections in one conversation retain REPL and native control", async () => {
  const f = await setup({ limit: 1 });
  try {
    for (let n = 0; n < 12; n++) {
      const peer = await f.connect("same-conversation");
      try {
        if (n === 0) {
          await run(peer.client, "set", "same-conversation");
          await run(peer.client, "observe", "same-conversation");
        } else {
          expect((await run(peer.client, "get", "same-conversation")).memory).toBe(42);
          expect((await run(peer.client, "action", "same-conversation")).actionExecuted).toBe(true);
        }
      } finally {
        await peer.close();
      }
    }
    expect(f.http.contextCount).toBe(1);
    expect(f.http.sessionCount).toBe(0);
    expect(f.created).toBe(2); // one closed schema probe, one live execution
    const events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const ids = new Set(
      events.filter((e) => e.event === "call").map((e) => e.meta["x-codex-turn-metadata"].turn_id),
    );
    expect(ids.size).toBe(1);
    expect(events.filter((e) => e.event === "turn_ended")).toHaveLength(0);
  } finally {
    await f.http.close();
  }
  const events = (await readFile(f.trace, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(events.filter((e) => e.event === "turn_ended")).toHaveLength(1);
}, 30_000);

test("metadata-only correlation survives unrelated transport closure", async () => {
  const f = await setup();
  try {
    const first = await f.connect();
    await run(first.client, "set", "metadata-only");
    await first.close();
    expect(f.http.sessionCount).toBe(0);
    expect(f.http.contextCount).toBe(1);
    const second = await f.connect();
    try {
      expect((await run(second.client, "get", "metadata-only")).memory).toBe(42);
    } finally {
      await second.close();
    }
  } finally {
    await f.http.close();
  }
}, 30_000);

test("same-conversation reconnect stays closed until explicit reset replaces a dead upstream", async () => {
  const f = await setup({ limit: 1 });
  try {
    const first = await f.connect("reinstalled-runtime");
    try {
      await run(first.client, "set");
      const interrupted = CallToolResultSchema.parse(
        await first.client.callTool({ name: "js", arguments: { code: "disconnect" } }),
      );
      expect(interrupted.isError).toBe(true);
    } finally {
      await first.close();
    }
    const second = await f.connect("reinstalled-runtime");
    try {
      await expect(run(second.client, "get")).rejects.toThrow("js_reset");
      expect(f.created).toBe(2);
      const reset = CallToolResultSchema.parse(
        await second.client.callTool({ name: "js_reset", arguments: {} }),
      );
      expect(reset.isError).not.toBe(true);
      expect(f.created).toBe(3);
      expect((await run(second.client, "get")).memory).toBe(0);
      await run(second.client, "observe");
      expect((await run(second.client, "action")).actionExecuted).toBe(true);
      expect(f.http.contextCount).toBe(1);
    } finally {
      await second.close();
    }
    const events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "call" && event.code === "set")).toHaveLength(
      1,
    );
    expect(
      events.filter((event) => event.event === "call" && event.code === "disconnect"),
    ).toHaveLength(1);
  } finally {
    await f.http.close();
  }
}, 30_000);

test("different conversations and authenticated owners never share execution state", async () => {
  const f = await setup();
  try {
    for (const [conversation, owner, expected] of [
      ["a", "owner-a", 0],
      ["b", "owner-a", 0],
      ["a", "owner-b", 0],
      ["a", "owner-a", 42],
    ] as const) {
      const peer = await f.connect(conversation, owner);
      try {
        expect((await run(peer.client, "get", conversation)).memory).toBe(expected);
        await run(peer.client, "set", conversation);
      } finally {
        await peer.close();
      }
    }
    expect(f.http.contextCount).toBe(3);
  } finally {
    await f.http.close();
  }
}, 30_000);

test("context capacity rejects new work but preserves existing conversation and discovery", async () => {
  const f = await setup({ limit: 1 });
  try {
    const a = await f.connect("a");
    const b = await f.connect("b");
    try {
      await run(a.client, "set", "a");
      expect((await b.client.listTools()).tools.length).toBe(2);
      await expect(run(b.client, "set", "b")).rejects.toThrow();
      expect((await run(a.client, "get", "a")).memory).toBe(42);
      expect(f.created).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    await f.http.close();
  }
}, 30_000);

test("conversation contexts expire after inactivity, not after one HTTP client closes", async () => {
  const f = await setup({ idleMs: 150 });
  try {
    const peer = await f.connect("idle");
    await run(peer.client, "observe", "idle");
    await peer.close();
    expect(f.http.contextCount).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(f.http.contextCount).toBe(0);
    const events = (await readFile(f.trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.event === "turn_ended")).toHaveLength(1);
  } finally {
    await f.http.close();
  }
}, 30_000);

test("in-flight conversation work cannot be evicted by the idle timer", async () => {
  const f = await setup({ idleMs: 100 });
  const peer = await f.connect("active");
  const abort = new AbortController();
  try {
    const pending = peer.client.callTool(
      { name: "js", arguments: { code: "slow" }, _meta: { "openai/session": "active" } },
      undefined,
      { signal: abort.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.http.contextCount).toBe(1);
    abort.abort();
    await expect(pending).rejects.toThrow();
  } finally {
    abort.abort();
    await peer.close();
    await f.http.close();
  }
}, 30_000);

test("conversation identity rejects mismatches and malformed values", () => {
  const headers = new Headers({ "x-openai-session": "a" });
  expect(conversationId(headers, { "openai/session": "a" })).toBe("a");
  expect(() => conversationId(headers, { "openai/session": "b" })).toThrow();
  expect(() => conversationId(new Headers(), { "openai/session": "" })).toThrow();
  expect(() => conversationId(new Headers(), { "openai/session": {} })).toThrow();
  expect(() => conversationId(new Headers(), { "openai/session": "x".repeat(513) })).toThrow();
  expect(conversationId(new Headers(), undefined)).toBeUndefined();
});

test("authentication dependency outage is 503, not a false OAuth 401", async () => {
  const config = decodeAccessConfig({
    issuer: "https://test.cloudflareaccess.com",
    audience: "a".repeat(64),
    publicOrigin: "https://lcu.example.com",
  });
  const verify = async () => {
    throw new TypeError("Network failed");
  };
  const authenticate = authenticator(token, config, verify);
  await expect(
    authenticate(
      new Request("https://lcu.example.com/mcp", {
        headers: { "cf-access-jwt-assertion": "opaque" },
      }),
    ),
  ).rejects.toBeInstanceOf(AuthUnavailableError);
  const f = await startHttp(
    () => {
      throw new Error("No LCU process should start");
    },
    { port: 0, token, publicOrigins: [] },
    silent,
    async () => {
      throw new AuthUnavailableError();
    },
  );
  try {
    const response = await fetch(f.url);
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("retry-after")).toBe("2");
  } finally {
    await f.close();
  }
});

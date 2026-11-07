import { randomUUID } from "node:crypto";
import { VERSION } from "./version.ts";
import { startWebServer, readJsonBody, BodyLimitError } from "./web-server.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { JSONRPCMessageSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  authenticator,
  AuthUnavailableError,
  type AccessConfig,
  type Authenticate,
  type TailnetAuth,
} from "./auth.ts";
import {
  createMcpServer,
  DesktopQueue,
  UpstreamTeardownUnconfirmedError,
  type Surface,
  type ToolCall,
} from "./session.ts";
import { publicSurface, stderrAudit, type Audit, type Upstream } from "./lcu.ts";
import { conversationId, contextKey, ContextCapacityError, ExecutionContexts } from "./contexts.ts";

export interface HttpOptions {
  port: number;
  token: string;
  publicOrigins: string[];
  idleMs?: number;
  maxSessions?: number;
  maxTransports?: number;
  discoveryIdleMs?: number;
  /** Injectable monotonic clock for deterministic lifecycle tests. */
  now?: () => number;
  access?: AccessConfig;
  tailnet?: TailnetAuth;
}
const json = (status: number, message: string) => Response.json({ error: message }, { status });
type TransportEntry = {
  server: ReturnType<typeof createMcpServer>;
  transport: WebStandardStreamableHTTPServerTransport;
  principal: string;
  key: string;
  touched: number;
  used: boolean;
  active: number;
};

export async function startHttp(
  factory: () => Upstream,
  options: HttpOptions,
  audit: Audit = stderrAudit,
  authenticate: Authenticate = authenticator(
    options.token,
    options.access,
    undefined,
    options.tailnet,
  ),
) {
  if (options.token.length < 32) throw new Error("HTTP token must have at least 32 characters.");
  const queue = new DesktopQueue();
  const now = options.now ?? (() => performance.now());
  const idleMs = options.idleMs ?? 600_000;
  const discoveryIdleMs = options.discoveryIdleMs ?? Math.min(idleMs, 120_000);
  const contexts = new ExecutionContexts(
    factory,
    queue,
    audit,
    options.maxSessions ?? 8,
    idleMs,
    reclaimIdleTransport,
    now,
  );
  const sessions = new Map<string, TransportEntry>();
  const initializing = new Set<Promise<void>>();
  const stateless = new Map<string, AbortController>();
  const shutdown = new AbortController();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let surfacePromise: Promise<Surface> | undefined;
  let discoveryCloseUnconfirmed = false;
  let port = options.port;
  const publicOrigins = new Set([...options.publicOrigins, ...(options.tailnet?.origins ?? [])]);

  /** Discover the original schemas once per broker, never a permanent process per tools/list. */
  function surface() {
    return (surfacePromise ??= (async () => {
      const upstream = factory();
      const closeProbe = async () => {
        try {
          await upstream.close();
        } catch {
          throw new UpstreamTeardownUnconfirmedError();
        }
      };
      let discovered: Surface;
      try {
        await upstream.connect();
        discovered = publicSurface(upstream);
      } catch (error) {
        await closeProbe();
        throw error;
      }
      await closeProbe();
      return discovered;
    })().catch((error) => {
      if (error instanceof UpstreamTeardownUnconfirmedError) {
        // Discovery also owns a process. Retain the rejected promise instead
        // of spawning unbounded replacements outside the execution limit.
        discoveryCloseUnconfirmed = true;
        audit("discovery_upstream_quarantined");
      } else surfacePromise = undefined;
      throw error;
    }));
  }
  async function drop(id: string) {
    const entry = sessions.get(id);
    if (!entry) return;
    sessions.delete(id);
    try {
      await contexts.close(entry.key, "transport");
    } finally {
      await entry.server.close();
    }
  }
  async function reclaimIdleTransport(principal: string) {
    // Release execution capacity only. The healthy MCP client may continue
    // pinging this transport and can explicitly reset before its next js.
    const eligible = new Set(
      [...sessions.values()]
        .filter((entry) => entry.principal === principal && entry.used && entry.active === 0)
        .map((entry) => entry.key),
    );
    const key = contexts.oldestIdleTransport(principal, (key) => eligible.has(key));
    if (key) await contexts.close(key, "capacity");
  }
  function invoke(
    key: string,
    principal: string,
    signal?: AbortSignal,
    kind: "transport" | "conversation" = "conversation",
    transportId?: string,
  ): ToolCall {
    return (name, args, extra) => {
      const entry = transportId ? sessions.get(transportId) : undefined;
      // The first js of a newly initialized stateful transport remains backward
      // compatible. Every later js requires a retained context or explicit reset.
      const firstUse = kind === "transport" && entry?.used === false && name === "js";
      if (entry && (name === "js" || name === "js_reset")) entry.used = true;
      return contexts.call(
        key,
        principal,
        name,
        args,
        {
          requestId: extra.requestId,
          signal: AbortSignal.any([extra.signal, shutdown.signal, ...(signal ? [signal] : [])]),
        },
        firstUse ? "first-use" : "retained",
        kind,
      );
    };
  }
  async function serveStateless(
    request: Request,
    body: unknown,
    principal: string,
    conversation: string,
  ) {
    if (request.method === "GET")
      return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
    // A short transport ending does not imply the ChatGPT conversation ended.
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    const message = JSONRPCMessageSchema.parse(body);
    const key = contextKey(principal, "conversation", conversation);
    if ("method" in message && message.method === "notifications/cancelled") {
      const id = message.params?.requestId;
      if (typeof id === "number" || typeof id === "string")
        stateless.get(JSON.stringify([key, id]))?.abort();
      return new Response(null, { status: 202 });
    }
    if (stateless.size >= 64) return json(429, "Too many in-flight MCP requests.");
    // JSON-RPC IDs in independent discovery handshakes are not globally unique.
    // Only simultaneous tool invocations with the same context/id conflict.
    const id =
      "method" in message && message.method === "tools/call" && "id" in message
        ? message.id
        : randomUUID();
    const requestKey = JSON.stringify([key, id]);
    if (stateless.has(requestKey))
      return json(
        409,
        "This request ID is already running. Do not replay a possible desktop action.",
      );
    const controller = new AbortController();
    stateless.set(requestKey, controller);
    let server: ReturnType<typeof createMcpServer> | undefined;
    try {
      server = createMcpServer(
        await surface(),
        invoke(key, principal, AbortSignal.any([request.signal, controller.signal])),
        audit,
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: message });
      audit("mcp_conversation_request", {
        context: key.slice(0, 12),
        method: "method" in message ? message.method : "response",
        contexts: contexts.size,
        status: response.status,
      });
      return response;
    } finally {
      stateless.delete(requestKey);
      await server?.close();
    }
  }

  const server = await startWebServer(async (request) => {
    let principal: string | undefined;
    try {
      principal = await authenticate(request);
    } catch (error) {
      if (!(error instanceof AuthUnavailableError)) audit("authentication_internal_error");
      audit("authentication_unavailable");
      return new Response("Authentication service temporarily unavailable", {
        status: 503,
        headers: { "Retry-After": "2" },
      });
    }
    if (!principal)
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      });
    if (closing) return json(503, "Server is shutting down.");
    const allowedOrigins = new Set([
      ...publicOrigins,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
    ]);
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (![...allowedOrigins].some((origin) => new URL(origin).host === host))
      return json(403, "Host is not allowed.");
    const origin = request.headers.get("origin");
    if (origin && !allowedOrigins.has(origin)) return json(403, "Origin is not allowed.");
    const url = new URL(request.url);
    if (url.pathname === "/healthz")
      return Response.json({
        ok: true,
        version: VERSION,
        sessions: sessions.size + contexts.size,
        transports: sessions.size,
        connectedTransports: sessions.size,
        ...contexts.snapshot,
        quarantinedDiscoveryProbes: discoveryCloseUnconfirmed ? 1 : 0,
        pendingRequests: stateless.size + initializing.size,
      });
    if (url.pathname !== "/mcp") return json(404, "Not found.");
    if (!["POST", "GET", "DELETE"].includes(request.method))
      return json(405, "Method not allowed.");
    let body: unknown;
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
        return json(415, "Expected application/json.");
      try {
        body = await readJsonBody(request);
      } catch (error) {
        if (error instanceof BodyLimitError) return json(413, error.message);
        return json(400, "Invalid JSON.");
      }
    }
    const parsed = body === undefined ? undefined : JSONRPCMessageSchema.safeParse(body);
    if (parsed && !parsed.success) return json(400, "Invalid MCP message.");
    const rpc = parsed?.success ? parsed.data : undefined;
    let conversation: string | undefined;
    try {
      conversation = conversationId(
        request.headers,
        rpc && "params" in rpc ? rpc.params?._meta : undefined,
      );
    } catch {
      return json(400, "Invalid or conflicting conversation correlation identifiers.");
    }
    // ChatGPT creates fresh HTTP MCP clients for consecutive tool calls. Their logical
    // state belongs to this verified owner + opaque conversation, not transport IDs.
    if (conversation !== undefined) {
      try {
        return await serveStateless(request, body, principal, conversation);
      } catch (error) {
        audit("stateless_request_failed");
        return json(
          error instanceof ContextCapacityError ? 429 : 503,
          "MCP request failed before a response. Do not blindly replay actions.",
        );
      }
    }
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const entry = sessions.get(id);
      if (!entry || entry.principal !== principal)
        return json(404, "Unknown or expired MCP session. Initialize a new session.");
      entry.touched = now();
      entry.active++;
      try {
        return await entry.transport.handleRequest(
          request,
          body === undefined ? undefined : { parsedBody: body },
        );
      } catch {
        audit("http_request_failed");
        return json(500, "MCP request failed.");
      } finally {
        entry.active--;
        entry.touched = now();
      }
    }
    if (request.method !== "POST" || !isInitializeRequest(body))
      return json(400, "Initialize a new MCP session first.");
    if (sessions.size + initializing.size >= (options.maxTransports ?? 64)) {
      const unused = [...sessions].find(
        ([, entry]) =>
          entry.active === 0 && now() - entry.touched > (entry.used ? idleMs : discoveryIdleMs),
      );
      if (unused) await drop(unused[0]);
      else return json(429, "Too many live MCP transports; no active context was evicted.");
    }
    let finish = () => {};
    const initialization = new Promise<void>((resolve) => {
      finish = resolve;
    });
    initializing.add(initialization);
    const newId = randomUUID();
    const key = contextKey(principal, "transport", newId);
    try {
      const info = await surface();
      if (closing) return json(503, "Server is shutting down.");
      const protocol = createMcpServer(
        info,
        invoke(key, principal, undefined, "transport", newId),
        audit,
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => newId,
        onsessionclosed: () => drop(newId),
      });
      sessions.set(newId, {
        server: protocol,
        transport,
        principal,
        key,
        touched: now(),
        used: false,
        active: 0,
      });
      await protocol.connect(transport);
      const response = await transport.handleRequest(request, { parsedBody: body });
      if (!response.ok) await drop(newId);
      return response;
    } catch {
      await drop(newId).catch(() => {});
      audit("http_session_start_failed");
      return json(503, "Could not discover LCU. Check local installation and gateway diagnostics.");
    } finally {
      initializing.delete(initialization);
      finish();
    }
  }, options.port);
  port = server.port ?? options.port;
  async function sweep() {
    const tick = now();
    await Promise.allSettled(
      [...sessions]
        .filter(
          ([, entry]) =>
            entry.active === 0 && tick - entry.touched > (entry.used ? idleMs : discoveryIdleMs),
        )
        .map(([id]) => drop(id).catch(() => audit("idle_transport_close_failed"))),
    );
    await contexts.sweep();
  }
  const sweepTimer = setInterval(
    () => {
      void sweep().catch(() => audit("idle_gc_failed"));
    },
    Math.min(30_000, Math.max(50, Math.min(idleMs, discoveryIdleMs) / 2)),
  );
  sweepTimer.unref();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get sessionCount() {
      return sessions.size;
    },
    get contextCount() {
      return contexts.size;
    },
    /** Internal deterministic clock-driven probe; no HTTP endpoint is added. */
    sweep,
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      shutdown.abort();
      clearInterval(sweepTimer);
      closePromise = (async () => {
        await Promise.allSettled(initializing);
        const results = await Promise.allSettled([
          ...[...sessions.keys()].map(drop),
          contexts.shutdown(),
          surfacePromise,
        ]);
        // Even a quarantined runtime must not keep the HTTP listener open.
        const listener = await Promise.allSettled([server.close()]);
        const rejected = [...results, ...listener].filter((result) => result.status === "rejected");
        if (rejected.length)
          throw new AggregateError(
            rejected.map((result) => result.reason),
            "LCU broker shutdown has unconfirmed cleanup",
          );
      })();
      return closePromise;
    },
  };
}

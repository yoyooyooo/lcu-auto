import { createServer } from "node:http";
import { Effect, Exit, Scope } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { NodeHttpServer } from "@effect/platform-node";

/** Effect owns the listener and request fibers; MCP continues to own its wire protocol. */
export async function startWebServer(
  handler: (request: Request) => Promise<Response>,
  port: number,
) {
  const scope = await Effect.runPromise(Scope.make());
  const node = createServer({ requestTimeout: 120_000, headersTimeout: 30_000 });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const server = yield* NodeHttpServer.make(() => node, {
          host: "127.0.0.1",
          port,
          gracefulShutdownTimeout: "2 seconds",
        });
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const web = yield* HttpServerRequest.toWeb(request);
            const response = yield* Effect.tryPromise((signal) =>
              handler(new Request(web, { signal })),
            );
            return HttpServerResponse.fromWeb(response);
          }).pipe(
            Effect.catch(() =>
              Effect.succeed(HttpServerResponse.text("Request failed", { status: 500 })),
            ),
          ),
        );
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    );
    const address = node.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP listener has no TCP address");
    return {
      port: address.port,
      close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}

export class BodyLimitError extends Error {}
/** Bound chunked requests as well as declared Content-Length before parsing MCP JSON. */
export async function readJsonBody(request: Request, maximum = 1_048_576): Promise<unknown> {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum)
    throw new BodyLimitError("Request body exceeds 1 MiB");
  if (!request.body) throw new SyntaxError("Missing request body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new BodyLimitError("Request body exceeds 1 MiB");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

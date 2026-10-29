import { randomBytes } from "node:crypto";
import { Console, Deferred, Effect, FileSystem, Option, Path } from "effect";
import { Command, Flag } from "effect/cli";
import { NodeServices } from "@effect/platform-node";
import { exactOrigin } from "./policy.ts";
import { loadAdapter, stderrAudit, upstreamFactory, type RuntimeOptions } from "./lcu.ts";
import { startStdio } from "./stdio.ts";
import { startHttp } from "./http.ts";
import { startConnect } from "./connect.ts";
import { readToken } from "./credentials.ts";
import { decodeAccessConfig } from "./auth.ts";
import { expandPath, runtimePaths } from "./paths.ts";
import { VERSION } from "./version.ts";
import { installService, controlService, serviceStatus } from "./service.ts";

const paths = runtimePaths();
const text = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description));
const tokenFlag = text("token-file", "Owner-private local credential file").pipe(
  Flag.withDefault(paths.tokenFile),
);
const runtimeFlags = {
  prefix: text("lcu-dir", "Installed LCU prefix containing current/adapters/client.mjs").pipe(
    Flag.withAlias("prefix"),
    Flag.withDefault(paths.lcuDir),
  ),
  command: text("lcu-command", "Override the installed LCU executable path").pipe(Flag.optional),
  scope: Flag.Literals("scope", ["always", "session", "once"]).pipe(
    Flag.withDefault("always"),
    Flag.withDescription("Maximum locally approved native-app consent scope"),
  ),
  chrome: Flag.Boolean("chrome").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Enable upstream Chrome support (requires its extension)"),
  ),
  origins: text("allow-origin", "Explicit browser-site HTTP(S) origin; repeatable").pipe(
    Flag.atLeast(0),
  ),
};
function runtimeOptions(input: {
  prefix: string;
  scope: "always" | "session" | "once";
  chrome: boolean;
  origins: readonly string[];
}): RuntimeOptions {
  if (input.origins.length && !input.chrome) throw new Error("--allow-origin requires --chrome");
  return {
    prefix: expandPath(input.prefix),
    scope: input.scope,
    chrome: input.chrome,
    origins: input.origins.map(exactOrigin),
  };
}
const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof Error ? error : new Error("Operation failed")),
  });

/** SIGINT/SIGTERM interruption and normal EOF both finalize the same owned resource. */
function running(open: (done: () => void) => Promise<{ close(): Promise<void> }>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const stopped = yield* Deferred.make<void>();
      const done = () => {
        Effect.runSync(Deferred.succeed(stopped, undefined));
      };
      yield* Effect.acquireRelease(
        attempt(() => open(done)),
        (resource) => attempt(() => resource.close()).pipe(Effect.orDie),
      );
      yield* Deferred.await(stopped);
    }),
  );
}

const mcp = Command.make(
  "mcp",
  {
    ...runtimeFlags,
    tokenFile: tokenFlag,
    url: text(
      "url",
      "Connect stdio to an existing authenticated loopback broker instead of starting LCU directly",
    ).pipe(Flag.optional),
  },
  (input) =>
    running(async (done) => {
      if (Option.isSome(input.url))
        return startConnect(input.url.value, await readToken(expandPath(input.tokenFile)), done);
      const factory = await upstreamFactory(
        runtimeOptions(input),
        stderrAudit,
        Option.isSome(input.command) ? [expandPath(input.command.value)] : undefined,
      );
      return startStdio(factory, done);
    }),
).pipe(
  Command.withDescription("Expose js and js_reset over stdio; stdout contains only MCP messages"),
);

const serve = Command.make(
  "serve",
  {
    ...runtimeFlags,
    tokenFile: tokenFlag,
    port: Flag.Int("port").pipe(
      Flag.withDefault(8789),
      Flag.withDescription("Loopback HTTP port (1–65535)"),
    ),
    publicOrigins: text(
      "public-origin",
      "Expected HTTPS reverse-proxy origin; repeatable, not authentication",
    ).pipe(Flag.atLeast(0)),
    accessConfig: text(
      "access-config",
      "JSON file with Cloudflare Access issuer, audience and publicOrigin",
    ).pipe(Flag.optional),
  },
  (input) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
        return yield* Effect.fail(new Error("Port must be between 1 and 65535"));
      const access = Option.isSome(input.accessConfig)
        ? yield* fs.readFileString(expandPath(input.accessConfig.value)).pipe(
            Effect.flatMap((raw) =>
              Effect.try({
                try: () => decodeAccessConfig(JSON.parse(raw)),
                catch: () =>
                  new Error("Invalid Access config: expected issuer, audience and publicOrigin"),
              }),
            ),
          )
        : undefined;
      return yield* running(async () => {
        const publicOrigins = input.publicOrigins.map((value) => {
          const origin = exactOrigin(value);
          if (!origin.startsWith("https://")) throw new Error("Public origins require HTTPS");
          return origin;
        });
        if (access && !publicOrigins.includes(access.publicOrigin))
          publicOrigins.push(access.publicOrigin);
        const token = await readToken(expandPath(input.tokenFile));
        const factory = await upstreamFactory(
          runtimeOptions(input),
          stderrAudit,
          Option.isSome(input.command) ? [expandPath(input.command.value)] : undefined,
        );
        const server = await startHttp(factory, {
          port: input.port,
          token,
          publicOrigins,
          ...(access ? { access } : {}),
        });
        stderrAudit("http_listening", { url: server.url, version: VERSION, scope: input.scope });
        return server;
      });
    }),
).pipe(
  Command.withDescription("Run the shared HTTP broker on loopback, authenticated on every request"),
);

const token = Command.make("token", { tokenFile: tokenFlag }, (input) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = expandPath(input.tokenFile);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
    yield* fs.writeFileString(target, randomBytes(32).toString("hex") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    yield* Console.log(`Created private credential file: ${target}`);
  }),
).pipe(
  Command.withDescription(
    "Create a local credential without printing it; never overwrite an existing file",
  ),
);

const config = Command.make("config").pipe(
  Command.withDescription("Inspect platform-aware configuration locations"),
  Command.withSubcommands([
    Command.make("paths", {}, () => Console.log(JSON.stringify(runtimePaths(), null, 2))).pipe(
      Command.withDescription("Show resolved platform and environment-specific locations"),
    ),
  ]),
);
const doctor = Command.make(
  "doctor",
  { prefix: runtimeFlags.prefix, json: Flag.Boolean("json").pipe(Flag.withDefault(false)) },
  (input) =>
    Effect.gen(function* () {
      const result = yield* attempt(async () => {
        try {
          const adapter = await loadAdapter(expandPath(input.prefix));
          return {
            ok: true,
            version: VERSION,
            platform: process.platform,
            runtime: process.version,
            lcuInstalled: true,
            release: adapter.release,
            desktopPermissions: "not_checked",
          };
        } catch {
          return {
            ok: false,
            version: VERSION,
            platform: process.platform,
            runtime: process.version,
            lcuInstalled: false,
            desktopPermissions: "not_checked",
          };
        }
      });
      yield* Console.log(
        input.json
          ? JSON.stringify(result, null, 2)
          : result.ok
            ? "LCU adapter found. Desktop permissions and UI actions require a live MCP test."
            : "LCU adapter not found. Install upstream LCU or pass --lcu-dir. See docs/troubleshooting.md.",
      );
      if (!result.ok) return yield* Effect.fail(new Error("LCU runtime unavailable"));
    }),
).pipe(
  Command.withDescription("Check runtime discovery without controlling any desktop application"),
);

const serviceName = text(
  "name",
  "User service name; use the same name for install and control",
).pipe(Flag.withDefault("lcu-auto"));
const service = Command.make("service").pipe(
  Command.withDescription("Manage an opt-in user service: launchd, systemd or Task Scheduler"),
  Command.withSubcommands([
    Command.make(
      "install",
      {
        ...runtimeFlags,
        name: serviceName,
        tokenFile: tokenFlag,
        port: Flag.Int("port").pipe(Flag.withDefault(8789)),
        accessConfig: text("access-config", "Cloudflare Access config path").pipe(Flag.optional),
        replace: Flag.Boolean("replace-existing").pipe(Flag.withDefault(false)),
        dryRun: Flag.Boolean("dry-run").pipe(Flag.withDefault(false)),
      },
      (input) =>
        Effect.gen(function* () {
          if (input.chrome || input.origins.length)
            return yield* Effect.fail(
              new Error("Use an external supervisor for custom Chrome-enabled service arguments"),
            );
          if (input.port < 1 || input.port > 65535)
            return yield* Effect.fail(new Error("Port must be between 1 and 65535"));
          const result = yield* installService({
            name: input.name,
            tokenFile: input.tokenFile,
            port: input.port,
            prefix: input.prefix,
            scope: input.scope,
            replaceExisting: input.replace,
            dryRun: input.dryRun,
            ...(Option.isSome(input.accessConfig)
              ? { accessConfig: input.accessConfig.value }
              : {}),
            ...(Option.isSome(input.command) ? { command: input.command.value } : {}),
          });
          yield* Console.log(JSON.stringify(result, null, 2));
        }),
    ).pipe(
      Command.withDescription(
        "Install a definition pointing to this installed CLI; back up replacements; do not start",
      ),
    ),
    Command.make("status", { name: serviceName }, (input) =>
      serviceStatus(input.name).pipe(
        Effect.flatMap((value) => Console.log(JSON.stringify(value, null, 2))),
      ),
    ),
    ...(["start", "stop", "restart"] as const).map((action) =>
      Command.make(
        action,
        {
          name: serviceName,
          force: Flag.Boolean("force-disconnect").pipe(Flag.withDefault(false)),
        },
        (input) =>
          controlService(input.name, action, input.force).pipe(
            Effect.flatMap((value) => Console.log(JSON.stringify(value, null, 2))),
          ),
      ),
    ),
  ]),
);

const command = Command.make("lcu-auto").pipe(
  Command.withDescription("Use local computer-control tools from local or remote MCP clients"),
  Command.withSubcommands([mcp, serve, token, config, doctor, service]),
);
/** Transitional aliases change command spelling, never the MCP protocol or credentials. */
export function normalizeArgs(args: readonly string[]): string[] {
  const [first, ...rest] = args;
  if (first === "connect")
    return [
      "mcp",
      ...(rest.some((value) => value === "--url" || value.startsWith("--url="))
        ? []
        : ["--url", "http://127.0.0.1:8789/mcp"]),
      ...rest,
    ];
  if (first === "stdio") return ["mcp", ...rest];
  if (first === "http") return ["serve", ...rest];
  return args.length ? [...args] : ["--help"];
}
export function run(args: readonly string[]) {
  return Command.runWith(command, { version: VERSION })(normalizeArgs(args)).pipe(
    Effect.provide(NodeServices.layer),
  );
}
export const main = (args: string[]) => Effect.runPromise(run(args));

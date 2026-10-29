import { randomUUID } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { Effect, FileSystem, Path, Schema, Stream, Redacted } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { readTokenEffect } from "./credentials.ts";
import { runtimePaths, expandPath } from "./paths.ts";
import { servicePlan } from "./service-plan.ts";

const Manifest = Schema.Struct({
  name: Schema.String,
  platform: Schema.String,
  definitionPath: Schema.String,
  url: Schema.String,
  tokenFile: Schema.String,
  start: Schema.Array(Schema.String),
  stop: Schema.Array(Schema.String),
  status: Schema.Array(Schema.String),
});
type Manifest = typeof Manifest.Type;
const Health = Schema.Struct({
  ok: Schema.Boolean,
  sessions: Schema.Number,
  activeCalls: Schema.optionalKey(Schema.Number),
  pendingRequests: Schema.optionalKey(Schema.Number),
});

function execute(argv: readonly string[]) {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      if (!argv[0]) return yield* Effect.fail(new Error("Empty service command"));
      const child = yield* spawner.spawn(
        ChildProcess.make(argv[0], argv.slice(1), { stdin: "ignore" }),
      );
      const [code, output] = yield* Effect.all(
        [
          child.exitCode,
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.stderr.pipe(Stream.runDrain),
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), output };
    }),
  ).pipe(Effect.timeout("20 seconds"));
}
const manifestFile = (name: string) => `${runtimePaths().stateDir}/services/${name}.json`;
const readManifest = (name: string) =>
  Effect.gen(function* () {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name))
      return yield* Effect.fail(new Error("Invalid service name"));
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(manifestFile(name));
    const value = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Manifest)(JSON.parse(raw)),
      catch: () => new Error("Invalid service manifest; inspect the owner-private state directory"),
    });
    if (value.name !== name || value.platform !== process.platform)
      return yield* Effect.fail(new Error("Service manifest does not match this host"));
    return value;
  });
function health(manifest: Manifest) {
  return Effect.gen(function* () {
    const token = yield* readTokenEffect(manifest.tokenFile);
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(new URL("/healthz", manifest.url)).pipe(
        HttpClientRequest.bearerToken(Redacted.make(token)),
      ),
    );
    if (response.status !== 200) return yield* Effect.fail(new Error("Broker is unavailable"));
    return yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Health)));
  }).pipe(Effect.timeout("4 seconds"), Effect.provide(FetchHttpClient.layer));
}
export const serviceStatus = (name: string) =>
  Effect.gen(function* () {
    const manifest = yield* readManifest(name);
    const status = yield* execute(manifest.status).pipe(
      Effect.catch(() => Effect.succeed({ code: 1, output: "" })),
    );
    const broker = yield* health(manifest).pipe(
      Effect.catch(() => Effect.succeed({ ok: false, sessions: 0 })),
    );
    return {
      name,
      registered: status.code === 0,
      health: broker,
      definitionPath: manifest.definitionPath,
    };
  });

export interface InstallServiceOptions {
  name: string;
  tokenFile: string;
  port: number;
  prefix: string;
  scope: "always" | "session" | "once";
  accessConfig?: string;
  command?: string;
  replaceExisting: boolean;
  dryRun: boolean;
}
export const installService = (options: InstallServiceOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const paths = runtimePaths();
    const tokenFile = expandPath(options.tokenFile);
    const entry = yield* fs.realPath(expandPath(process.argv[1] ?? ""));
    const node = yield* fs.realPath(process.execPath);
    const args = [
      "serve",
      "--port",
      String(options.port),
      "--token-file",
      tokenFile,
      "--lcu-dir",
      expandPath(options.prefix),
      "--scope",
      options.scope,
      ...(options.accessConfig ? ["--access-config", expandPath(options.accessConfig)] : []),
      ...(options.command ? ["--lcu-command", expandPath(options.command)] : []),
    ];
    const plan = servicePlan({
      platform: process.platform,
      name: options.name,
      home: homedir(),
      stateDir: paths.stateDir,
      node,
      entry,
      args,
      uid: process.getuid?.() ?? 0,
      user:
        process.platform === "win32" && process.env.USERDOMAIN
          ? `${process.env.USERDOMAIN}\\${userInfo().username}`
          : userInfo().username,
    });
    if (options.dryRun) return { installed: false, ...plan };
    yield* readTokenEffect(tokenFile);
    if (options.accessConfig) yield* fs.access(expandPath(options.accessConfig));
    const previous = yield* fs.exists(plan.definitionPath);
    if (previous) {
      const info = yield* fs.lstat(plan.definitionPath);
      if (info.type !== "File")
        return yield* Effect.fail(new Error("Refusing a symlink or non-file service definition"));
      const old = yield* fs.readFileString(plan.definitionPath);
      if (!old.includes("Managed by lcu-auto") && !options.replaceExisting)
        return yield* Effect.fail(
          new Error(
            "Existing service definition is not managed by lcu-auto; use --replace-existing only after inspecting it",
          ),
        );
      if (old === plan.definition)
        return { installed: true, unchanged: true, definitionPath: plan.definitionPath };
      const status = yield* execute(plan.status);
      if (status.code === 0)
        return yield* Effect.fail(
          new Error("Stop the existing service before replacing its definition"),
        );
      const backups = path.join(paths.stateDir, "backups");
      yield* fs.makeDirectory(backups, { recursive: true, mode: 0o700 });
      yield* fs.writeFileString(path.join(backups, `${options.name}-${randomUUID()}.backup`), old, {
        mode: 0o600,
        flag: "wx",
      });
    }
    for (const directory of [
      plan.logs,
      path.dirname(plan.definitionPath),
      path.dirname(manifestFile(options.name)),
    ]) {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    }
    yield* fs.writeFileString(plan.definitionPath, plan.definition, { mode: 0o600 });
    const manifest: Manifest = {
      name: options.name,
      platform: process.platform,
      definitionPath: plan.definitionPath,
      url: `http://127.0.0.1:${options.port}/mcp`,
      tokenFile,
      start: plan.start,
      stop: plan.stop,
      status: plan.status,
    };
    yield* fs.writeFileString(
      manifestFile(options.name),
      JSON.stringify(manifest, null, 2) + "\n",
      { mode: 0o600 },
    );
    for (const argv of plan.register) {
      const result = yield* execute(argv);
      if (result.code !== 0)
        return yield* Effect.fail(
          new Error(`Service registration failed (${argv[0]}); definition retained for diagnosis`),
        );
    }
    return { installed: true, definitionPath: plan.definitionPath, started: false };
  });

export const controlService = (
  name: string,
  action: "start" | "stop" | "restart",
  force: boolean,
) =>
  Effect.gen(function* () {
    const manifest = yield* readManifest(name);
    if (action !== "start") {
      const status = yield* execute(manifest.status).pipe(
        Effect.catch(() => Effect.succeed({ code: 1, output: "" })),
      );
      if (status.code === 0) {
        const broker = yield* health(manifest).pipe(
          Effect.catch(() => Effect.succeed({ ok: false, sessions: 0 })),
        );
        if (!force && (!broker.ok || broker.sessions > 0))
          return yield* Effect.fail(
            new Error(
              "Broker has connected clients or cannot report them; close clients first or explicitly use --force-disconnect",
            ),
          );
        const result = yield* execute(manifest.stop);
        if (result.code !== 0) return yield* Effect.fail(new Error("Service stop failed"));
        if (process.platform === "darwin") {
          let unloaded = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            if ((yield* execute(manifest.status)).code !== 0) {
              unloaded = true;
              break;
            }
            yield* Effect.sleep("250 millis");
          }
          if (!unloaded)
            return yield* Effect.fail(
              new Error("Service has not finished unloading; no replacement was started"),
            );
        }
      }
    }
    if (action !== "stop") {
      const before = yield* health(manifest).pipe(
        Effect.catch(() => Effect.succeed({ ok: false, sessions: 0 })),
      );
      if (!before.ok) {
        const result = yield* execute(manifest.start);
        if (result.code !== 0)
          return yield* Effect.fail(
            new Error("Service start failed; inspect the service manager logs"),
          );
      }
      let ready = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const current = yield* health(manifest).pipe(
          Effect.catch(() => Effect.succeed({ ok: false, sessions: 0 })),
        );
        if (current.ok) {
          ready = true;
          break;
        }
        yield* Effect.sleep("300 millis");
      }
      if (!ready) return yield* Effect.fail(new Error("Service did not become ready"));
    }
    return yield* serviceStatus(name);
  });

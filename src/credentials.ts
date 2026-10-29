import { Effect, FileSystem, Option, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";

const Token = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,256}$/));
export const readTokenEffect = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.lstat(path);
    const owner = Option.getOrUndefined(info.uid);
    if (
      info.type !== "File" ||
      (process.platform !== "win32" && (info.mode & 0o077) !== 0) ||
      (process.getuid && owner !== process.getuid())
    ) {
      return yield* Effect.fail(
        new Error(
          "Credential must be an owner-private regular file (0600 on Unix; restrict its ACL on Windows)",
        ),
      );
    }
    const value = (yield* fs.readFileString(path)).trim();
    return yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Token)(value),
      catch: () => new Error("Invalid local credential file"),
    });
  });
export const readToken = (path: string) =>
  Effect.runPromise(readTokenEffect(path).pipe(Effect.provide(NodeFileSystem.layer)));

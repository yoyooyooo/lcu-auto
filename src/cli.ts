#!/usr/bin/env node
import { Console, Effect } from "effect";
import { NodeRuntime } from "@effect/platform-node";
import { run } from "./commands.ts";

NodeRuntime.runMain(
  run(process.argv.slice(2)).pipe(
    Effect.tapError((error) =>
      Console.error(error instanceof Error ? error.message : "Command failed"),
    ),
  ),
  { disableErrorReporting: true },
);

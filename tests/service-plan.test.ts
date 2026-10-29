import { expect, test } from "bun:test";
import { servicePlan, windowsArg } from "../src/service-plan.ts";
const settings = {
  platform: "darwin" as const,
  name: "lcu-auto",
  home: "/home/tester",
  stateDir: "/state/example",
  node: "/usr/bin/node",
  entry: "/apps/space & name/cli.js",
  args: ["serve", "--scope", "always"],
  user: "tester",
  uid: 501,
};
test("launchd uses literal argument arrays and escapes XML paths", () => {
  const plan = servicePlan(settings);
  expect(plan.definition).toContain("space &amp; name");
  expect(plan.definition).toContain("<key>Umask</key><integer>63</integer>");
  expect(plan.start).toEqual([
    "launchctl",
    "bootstrap",
    "gui/501",
    "/home/tester/Library/LaunchAgents/lcu-auto.plist",
  ]);
});
test("systemd units escape specifiers and variable expansion", () => {
  const plan = servicePlan({
    ...settings,
    platform: "linux",
    entry: "/apps/%value/$literal/cli.js",
  });
  expect(plan.definition).toContain("%%value/$$literal");
  expect(plan.register).toHaveLength(2);
});
test("Windows tasks run as the interactive user without elevation or credentials", () => {
  const plan = servicePlan({
    ...settings,
    platform: "win32",
    home: "C:\\Users\\tester",
    stateDir: "C:\\state",
    node: "C:\\Program Files\\nodejs\\node.exe",
    entry: "C:\\apps\\lcu-auto\\dist\\cli.js",
  });
  expect(plan.definition).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  expect(plan.definition).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(plan.register[0]?.[0]).toBe("schtasks.exe");
  expect(windowsArg("C:\\folder\\")).toBe('"C:\\folder\\\\"');
});
test("service names and newline arguments reject injection", () => {
  expect(() => servicePlan({ ...settings, name: "bad/name" })).toThrow();
  expect(() => servicePlan({ ...settings, args: ["serve\nmalicious"] })).toThrow();
});

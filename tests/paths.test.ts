import { expect, test } from "bun:test";
import { runtimePaths } from "../src/paths.ts";

test("Unix defaults and absolute XDG overrides do not depend on the maintainer's machine", () => {
  expect(runtimePaths("linux", "/home/tester", {}).configDir).toBe("/home/tester/.config/lcu-auto");
  expect(runtimePaths("darwin", "/home/tester", { XDG_CONFIG_HOME: "/var/config" }).tokenFile).toBe(
    "/var/config/lcu-auto/http.token",
  );
  expect(runtimePaths("linux", "/home/tester", { XDG_CONFIG_HOME: "relative" }).configDir).toBe(
    "/home/tester/.config/lcu-auto",
  );
  expect(
    runtimePaths("linux", "/home/tester", {
      LCU_AUTO_PREFIX: "/opt/lcu",
      LCU_AUTO_CONFIG_DIR: "/etc/lcu-auto",
    }).lcuDir,
  ).toBe("/opt/lcu");
});
test("Windows uses APPDATA/LOCALAPPDATA and native separators", () => {
  const paths = runtimePaths("win32", "C:\\Users\\tester", {
    APPDATA: "D:\\Roaming",
    LOCALAPPDATA: "D:\\Local",
  });
  expect(paths.configDir).toBe("D:\\Roaming\\lcu-auto");
  expect(paths.lcuDir).toBe("D:\\Local\\lcu");
  expect(paths.stateDir).toBe("D:\\Local\\lcu-auto");
});
test("explicit absolute path overrides win and relative overrides are ignored", () => {
  const paths = runtimePaths("win32", "C:\\Users\\tester", {
    LCU_AUTO_TOKEN_FILE: "E:\\keys\\local.token",
    LCU_AUTO_DATA_DIR: "relative",
  });
  expect(paths.tokenFile).toBe("E:\\keys\\local.token");
  expect(paths.dataDir).toBe("C:\\Users\\tester\\AppData\\Local\\lcu-auto");
});

import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32, posix } from "node:path";

export interface RuntimePaths {
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly lcuDir: string;
  readonly tokenFile: string;
}

/** Pure platform policy; injected inputs make Windows and XDG behavior testable anywhere. */
export function runtimePaths(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): RuntimePaths {
  const path = platform === "win32" ? win32 : posix;
  const absolute = (value: string | undefined, fallback: string) =>
    value && path.isAbsolute(value) ? value : fallback;
  const configBase =
    platform === "win32"
      ? absolute(env.APPDATA, path.join(home, "AppData", "Roaming"))
      : absolute(env.XDG_CONFIG_HOME, path.join(home, ".config"));
  const dataBase =
    platform === "win32"
      ? absolute(env.LOCALAPPDATA, path.join(home, "AppData", "Local"))
      : absolute(env.XDG_DATA_HOME, path.join(home, ".local", "share"));
  const stateBase =
    platform === "win32"
      ? dataBase
      : absolute(env.XDG_STATE_HOME, path.join(home, ".local", "state"));
  const configDir = absolute(env.LCU_AUTO_CONFIG_DIR, path.join(configBase, "lcu-auto"));
  return {
    configDir,
    dataDir: absolute(env.LCU_AUTO_DATA_DIR, path.join(dataBase, "lcu-auto")),
    stateDir: absolute(env.LCU_AUTO_STATE_DIR, path.join(stateBase, "lcu-auto")),
    // Match LCU's Unix installer; Windows users can point to an independently installed runtime.
    lcuDir: absolute(
      env.LCU_AUTO_PREFIX,
      platform === "linux" ? "/opt/lcu" : path.join(dataBase, "lcu"),
    ),
    tokenFile: absolute(env.LCU_AUTO_TOKEN_FILE, path.join(configDir, "http.token")),
  };
}

export function expandPath(value: string): string {
  const expanded =
    value === "~"
      ? homedir()
      : value.startsWith("~/") || value.startsWith("~\\")
        ? join(homedir(), value.slice(2))
        : value;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

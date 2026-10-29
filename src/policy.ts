export type ApprovalScope = "always" | "session" | "once";

/** Choose only scopes actually offered by the original runtime. */
export function chooseScope(
  offered: readonly string[],
  maximum: ApprovalScope,
): ApprovalScope | undefined {
  const preference: readonly ApprovalScope[] =
    maximum === "always"
      ? ["always", "session", "once"]
      : maximum === "session"
        ? ["session", "once"]
        : ["once"];
  return preference.find((scope) => offered.includes(scope));
}

export function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.hostname.includes("*")
  ) {
    throw new Error(
      `Expected an exact HTTP(S) origin, without path, credentials or wildcard: ${value}`,
    );
  }
  return url.origin;
}

/** LCU and any app it launches must not inherit the gateway's credentials. */
export function childEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of [
    "HOME",
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "CODEX_HOME",
    "DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "LCU_NODE_REPL_SANDBOX",
    "LCU_LINUX_INPUT_TRANSLATION",
    "LCU_NO_UPDATE_CHECK",
    "LCU_DIAGNOSTIC_LOG",
    "SKY_CUA_SERVICE_NATIVE_PIPE_PATH",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  // Never inherit the upstream testing switch that disables agent-host protection.
  result.LCU_ALLOW_AGENT_HOST_APPROVAL = "0";
  return result;
}

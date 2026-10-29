import { posix, win32 } from "node:path";

export interface ServiceSettings {
  platform: NodeJS.Platform;
  name: string;
  home: string;
  stateDir: string;
  node: string;
  entry: string;
  args: readonly string[];
  user: string;
  uid: number;
}
export interface ServicePlan {
  definitionPath: string;
  definition: string;
  start: readonly string[];
  stop: readonly string[];
  status: readonly string[];
  register: readonly (readonly string[])[];
  logs: string;
}
export function xml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
const unitArg = (value: string) =>
  `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/\$/g, () => "$$")}"`;
/** Windows CommandLineToArgvW quoting, not shell interpolation. */
export function windowsArg(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}
export function servicePlan(input: ServiceSettings): ServicePlan {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(input.name))
    throw new Error(
      "Service name must contain only letters, numbers, dots, hyphens or underscores",
    );
  if ([input.node, input.entry, ...input.args].some((value) => /[\r\n]/.test(value)))
    throw new Error("Service arguments cannot contain newlines");
  const path = input.platform === "win32" ? win32 : posix;
  const logs = path.join(input.stateDir, "logs");
  const argv = [input.node, input.entry, ...input.args];
  if (input.platform === "darwin") {
    const definitionPath = path.join(input.home, "Library", "LaunchAgents", `${input.name}.plist`);
    const domain = `gui/${input.uid}`;
    const definition = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- Managed by lcu-auto -->\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(input.name)}</string>
<key>ProgramArguments</key><array>${argv.map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(input.stateDir)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(input.home)}</string><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>LCU_NO_UPDATE_CHECK</key><string>1</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>Interactive</string><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(path.join(logs, `${input.name}.out.log`))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, `${input.name}.err.log`))}</string>
</dict></plist>\n`;
    return {
      definitionPath,
      definition,
      logs,
      register: [],
      start: ["launchctl", "bootstrap", domain, definitionPath],
      stop: ["launchctl", "bootout", `${domain}/${input.name}`],
      status: ["launchctl", "print", `${domain}/${input.name}`],
    };
  }
  if (input.platform === "linux") {
    const unit = `${input.name}.service`;
    const definitionPath = path.join(input.home, ".config", "systemd", "user", unit);
    const definition = `# Managed by lcu-auto\n[Unit]\nDescription=LCU Auto MCP broker\nAfter=graphical-session.target network-online.target\n\n[Service]\nType=simple\nExecStart=${argv.map(unitArg).join(" ")}\nWorkingDirectory=${unitArg(input.stateDir)}\nEnvironment=LCU_NO_UPDATE_CHECK=1\nRestart=on-failure\nRestartSec=5\nUMask=0077\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
    return {
      definitionPath,
      definition,
      logs,
      register: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", unit],
      ],
      start: ["systemctl", "--user", "start", unit],
      stop: ["systemctl", "--user", "stop", unit],
      status: ["systemctl", "--user", "is-active", unit],
    };
  }
  if (input.platform === "win32") {
    const definitionPath = path.join(input.stateDir, "services", `${input.name}.xml`);
    const definition = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Managed by lcu-auto -->\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(input.user)}</UserId></LogonTrigger></Triggers><Principals><Principal id="Author"><UserId>${xml(input.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${xml(input.node)}</Command><Arguments>${xml([input.entry, ...input.args].map(windowsArg).join(" "))}</Arguments><WorkingDirectory>${xml(input.stateDir)}</WorkingDirectory></Exec></Actions></Task>\n`;
    return {
      definitionPath,
      definition,
      logs,
      register: [["schtasks.exe", "/Create", "/TN", input.name, "/XML", definitionPath, "/F"]],
      start: ["schtasks.exe", "/Run", "/TN", input.name],
      stop: ["schtasks.exe", "/End", "/TN", input.name],
      status: ["schtasks.exe", "/Query", "/TN", input.name, "/FO", "CSV", "/NH"],
    };
  }
  throw new Error(
    `No service manager integration for ${input.platform}; run lcu-auto serve under your own supervisor`,
  );
}

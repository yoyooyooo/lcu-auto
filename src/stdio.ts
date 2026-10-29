import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSession, DesktopQueue } from "./session.ts";
import { stderrAudit, type Upstream } from "./lcu.ts";

export async function startStdio(factory: () => Upstream, onclose: () => void = () => {}) {
  const session = await createSession(factory, new DesktopQueue());
  const previous = session.server.onclose;
  // The SDK transport reads data/error but does not turn stdin EOF into onclose.
  // A client closes stdin before sending SIGTERM, so finalize the control turn here.
  const eof = () => {
    void session
      .close()
      .catch(() => stderrAudit("stdio_cleanup_failed"))
      .finally(onclose);
  };
  process.stdin.once("end", eof);
  session.server.onclose = () => {
    process.stdin.removeListener("end", eof);
    previous?.();
    onclose();
  };
  try {
    await session.server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded) eof();
  } catch (error) {
    process.stdin.removeListener("end", eof);
    await session.close();
    throw error;
  }
  return session;
}

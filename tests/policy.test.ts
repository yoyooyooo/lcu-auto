import { describe, expect, test } from "bun:test";
import { childEnvironment, chooseScope, exactOrigin } from "../src/policy.ts";

describe("approval policy", () => {
  test("chooses an offered scope, never invents persistence", () => {
    expect(chooseScope(["once", "session", "always"], "always")).toBe("always");
    expect(chooseScope(["once", "session"], "always")).toBe("session");
    expect(chooseScope(["once"], "always")).toBe("once");
    expect(chooseScope(["once", "always"], "session")).toBe("once");
    expect(chooseScope(["always"], "once")).toBeUndefined();
  });
  test("accepts exact origins, not paths, wildcards or credentials", () => {
    expect(exactOrigin("https://example.com")).toBe("https://example.com");
    for (const value of [
      "https://*.example.com",
      "https://example.com/",
      "https://example.com/path",
      "file:///tmp/a",
      "https://me:secret@example.com",
    ]) {
      expect(() => exactOrigin(value)).toThrow();
    }
  });
  test("does not leak gateway/provider secrets or disable the host guard", () => {
    const env = childEnvironment({
      HOME: "/test",
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      LCU_AUTO_TOKEN: "secret",
      LCU_ALLOW_AGENT_HOST_APPROVAL: "1",
      NODE_REPL_REQUEST_META: "untrusted",
    });
    expect(env).toEqual({ HOME: "/test", PATH: "/bin", LCU_ALLOW_AGENT_HOST_APPROVAL: "0" });
  });
});

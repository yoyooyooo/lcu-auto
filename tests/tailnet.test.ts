import { expect, test } from "bun:test";
import { startHttp } from "../src/http.ts";

test("Tailnet HTTP broker enforces remote Host, independent bearer, and exact Origin", async () => {
  const localToken = "local-test-token-with-at-least-32-characters";
  const remoteToken = "remote-test-token-with-at-least-32-characters";
  const origin = "https://mini.example-tailnet.ts.net:9443";
  const http = await startHttp(
    () => {
      throw new Error("Health never opens an upstream runtime");
    },
    {
      port: 0,
      token: localToken,
      publicOrigins: [],
      tailnet: { origins: [origin], token: remoteToken },
    },
    () => {},
  );
  const url = new URL(http.url);
  url.pathname = "/healthz";
  const remoteHost = new URL(origin).host;
  const check = (host: string, token?: string, browserOrigin?: string) =>
    fetch(url, {
      headers: {
        host,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(browserOrigin ? { Origin: browserOrigin } : {}),
      },
    });
  try {
    expect((await check(remoteHost)).status).toBe(401);
    expect((await check(remoteHost, localToken)).status).toBe(401);
    expect((await check(remoteHost, remoteToken)).status).toBe(200);
    expect((await check(remoteHost, remoteToken, "https://evil.example.com")).status).toBe(403);
    expect((await check(remoteHost, remoteToken, origin)).status).toBe(200);
    expect((await check(url.host, remoteToken)).status).toBe(401);
    expect((await check(url.host, localToken)).status).toBe(200);
    expect((await check("public.example.com", remoteToken)).status).toBe(401);
  } finally {
    await http.close();
  }
});

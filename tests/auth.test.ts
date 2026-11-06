import { expect, test } from "bun:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { decodeAccessConfig, accessVerifier, authenticator } from "../src/auth.ts";
const config = decodeAccessConfig({
  issuer: "https://test.cloudflareaccess.com",
  audience: "a".repeat(64),
  publicOrigin: "https://lcu.example.com",
});
const pair = await generateKeyPair("RS256");
const jwk = await exportJWK(pair.publicKey);
const verify = accessVerifier(
  config,
  createLocalJWKSet({ keys: [{ ...jwk, kid: "fixture", alg: "RS256" }] }),
);
async function token(overrides: { aud?: string; iss?: string; exp?: string; type?: string } = {}) {
  return new SignJWT({ type: overrides.type ?? "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setSubject("owner")
    .setIssuedAt()
    .setIssuer(overrides.iss ?? config.issuer)
    .setAudience(overrides.aud ?? config.audience)
    .setExpirationTime(overrides.exp ?? "15m")
    .sign(pair.privateKey);
}
test("Access validates signature, issuer, audience, expiry and application token type", async () => {
  expect(await verify(await token())).toBe("access:owner");
  for (const invalid of [
    await token({ aud: "b".repeat(64) }),
    await token({ iss: "https://other.cloudflareaccess.com" }),
    await token({ exp: "-1h" }),
    await token({ type: "org" }),
    "unsigned.jwt.claims",
  ]) {
    await expect(verify(invalid)).rejects.toThrow();
  }
});
test("public hostname rejects the local token and requires a signed edge assertion", async () => {
  const localToken = "local-test-token-with-at-least-32-characters";
  const auth = authenticator(localToken, config, verify);
  expect(
    await auth(
      new Request("http://127.0.0.1:8789/mcp", {
        headers: { Authorization: `Bearer ${localToken}` },
      }),
    ),
  ).toBe("local");
  expect(
    await auth(
      new Request("https://lcu.example.com/mcp", {
        headers: { Authorization: `Bearer ${localToken}` },
      }),
    ),
  ).toBeUndefined();
  expect(
    await auth(
      new Request("https://lcu.example.com/mcp", {
        headers: {
          "Cf-Access-Jwt-Assertion": "fake",
          "Cf-Access-Authenticated-User-Email": "owner@example.com",
        },
      }),
    ),
  ).toBeUndefined();
  expect(
    await auth(
      new Request("https://lcu.example.com/mcp", {
        headers: { "Cf-Access-Jwt-Assertion": await token() },
      }),
    ),
  ).toBe("access:owner");
  expect(
    await auth(
      new Request("https://evil.example/mcp", {
        headers: { "Cf-Access-Jwt-Assertion": await token() },
      }),
    ),
  ).toBeUndefined();
});

test("Tailnet origin uses a separate remote bearer without broadening local or Cloudflare auth", async () => {
  const localToken = "local-test-token-with-at-least-32-characters";
  const remoteToken = "tailnet-test-token-with-at-least-32-characters";
  const tailnet = { origins: ["https://mini.example-tailnet.ts.net:9443"], token: remoteToken };
  const auth = authenticator(localToken, config, verify, tailnet);
  const check = (url: string, bearer: string) =>
    auth(new Request(url, { headers: { Authorization: `Bearer ${bearer}` } }));
  expect(await check("https://mini.example-tailnet.ts.net:9443/mcp", remoteToken)).toBe("tailnet");
  expect(await check("https://mini.example-tailnet.ts.net:9443/mcp", localToken)).toBeUndefined();
  expect(await check("http://127.0.0.1:8789/mcp", remoteToken)).toBeUndefined();
  expect(await check("https://lcu.example.com/mcp", remoteToken)).toBeUndefined();
  expect(await check("https://evil.example.com/mcp", remoteToken)).toBeUndefined();
  expect(await check("https://lcu.example.com/mcp", localToken)).toBeUndefined();
  expect(await check("http://127.0.0.1:8789/mcp", localToken)).toBe("local");
  expect(() =>
    authenticator(localToken, config, verify, { ...tailnet, token: localToken }),
  ).toThrow();
});

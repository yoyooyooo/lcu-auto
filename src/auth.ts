import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import { Schema } from "effect";

export const AccessConfigSchema = Schema.Struct({
  issuer: Schema.String.check(
    Schema.makeFilter<string>(
      (value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.hostname.endsWith(".cloudflareaccess.com") &&
            !url.username &&
            !url.password &&
            !url.port &&
            url.origin === value
          );
        } catch {
          return false;
        }
      },
      { message: "Expected a Cloudflare Access team origin" },
    ),
  ),
  audience: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  publicOrigin: Schema.String.check(
    Schema.makeFilter<string>(
      (value) => {
        try {
          return value.startsWith("https://") && new URL(value).origin === value;
        } catch {
          return false;
        }
      },
      { message: "Expected an HTTPS origin without a path" },
    ),
  ),
});
export const decodeAccessConfig = Schema.decodeUnknownSync(AccessConfigSchema);
export type AccessConfig = typeof AccessConfigSchema.Type;
export type Authenticate = (request: Request) => Promise<string | undefined>;

export class AuthUnavailableError extends Error {
  constructor() {
    super(
      "Access signing keys could not be verified because the authentication service is unavailable.",
    );
  }
}

/** Verify the signed edge assertion; never trust an email header or a decoded-only JWT. */
export function accessVerifier(config: AccessConfig, key?: JWTVerifyGetKey) {
  const keys =
    key ??
    createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 8_000,
      cacheMaxAge: 600_000,
      cooldownDuration: 30_000,
    });
  return async (token: string): Promise<string> => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat"],
      clockTolerance: 5,
    });
    if (payload.type !== "app")
      throw new errors.JWTClaimValidationFailed(
        "Expected an application Access token",
        payload,
        "type",
        "check_failed",
      );
    const subject = payload.sub || payload.common_name;
    if (typeof subject !== "string" || !subject)
      throw new errors.JWTClaimValidationFailed(
        "Access token has no subject",
        payload,
        "sub",
        "missing",
      );
    return `access:${subject}`;
  };
}

/** Local credentials are accepted only at a loopback Host, never at the public hostname. */
export function authenticator(
  token: string,
  config?: AccessConfig,
  verify = config ? accessVerifier(config) : undefined,
): Authenticate {
  if (token.length < 32) throw new Error("HTTP token must have at least 32 characters.");
  const expected = Buffer.from(`Bearer ${token}`);
  return async (request) => {
    const host = request.headers.get("host") ?? new URL(request.url).host;
    const isLocal = /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host);
    if (isLocal) {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      return supplied.length === expected.length && timingSafeEqual(supplied, expected)
        ? "local"
        : undefined;
    }
    if (!config || !verify || host !== new URL(config.publicOrigin).host) return undefined;
    const assertion = request.headers.get("cf-access-jwt-assertion");
    if (!assertion) return undefined;
    try {
      return await verify(assertion);
    } catch (error) {
      // A JWKS fetch failure is not an invalid login. Keep the endpoint closed but
      // return a retryable outage, not a false 401 that starts OAuth reauthorization.
      if (
        error instanceof errors.JOSEError &&
        !["ERR_JWKS_TIMEOUT", "ERR_JWKS_INVALID", "ERR_JOSE_GENERIC"].includes(error.code)
      )
        return undefined;
      throw new AuthUnavailableError();
    }
  };
}

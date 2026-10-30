import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export interface AccessClaims {
  aud: string[];
  email?: string;
  common_name?: string;
  sub?: string;
}

export interface AccessVerificationOptions {
  teamDomain: string;
  audience: string;
}

export type AccessTokenVerifier = (
  token: string,
  options: AccessVerificationOptions,
) => Promise<AccessClaims>;

export interface BrowserIdentity {
  email: string;
}

export interface ProcessorIdentity {
  id: string;
}

export const verifyAccessToken: AccessTokenVerifier = async (token, options) => {
  const issuer = normalizedTeamDomain(options.teamDomain);
  if (!options.audience.trim()) throw new Error("missing audience");
  let jwks = jwksByIssuer.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByIssuer.set(issuer, jwks);
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer,
    audience: options.audience,
    algorithms: ["RS256"],
  });
  return claimsFromPayload(payload);
};

export async function resolveBrowserIdentity(
  request: Request,
  options: AccessVerificationOptions,
  verifier: AccessTokenVerifier = verifyAccessToken,
): Promise<BrowserIdentity | null> {
  const claims = await verifiedClaims(request, options, verifier);
  const email = normalizeEmail(claims?.email ?? "");
  if (!email) return null;
  const forwardedEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
  if (forwardedEmail !== null && normalizeEmail(forwardedEmail) !== email) return null;
  return { email };
}

export async function resolveProcessorIdentity(
  request: Request,
  options: AccessVerificationOptions,
  verifier: AccessTokenVerifier = verifyAccessToken,
): Promise<ProcessorIdentity | null> {
  const claims = await verifiedClaims(request, options, verifier);
  const id = (claims?.common_name ?? claims?.sub ?? "").trim();
  if (!id || id.length > 128) return null;
  return { id };
}

async function verifiedClaims(
  request: Request,
  options: AccessVerificationOptions,
  verifier: AccessTokenVerifier,
): Promise<AccessClaims | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (!token || token.length > 8_192) return null;
  try {
    const claims = await verifier(token, options);
    return claims.aud.includes(options.audience) ? claims : null;
  } catch {
    return null;
  }
}

function normalizedTeamDomain(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("invalid team domain");
  }
  if (!url.hostname.endsWith(".cloudflareaccess.com")) {
    throw new Error("invalid team domain");
  }
  return url.origin;
}

function normalizeEmail(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return normalized.includes("@") && normalized.length <= 254 ? normalized : null;
}

function claimsFromPayload(payload: JWTPayload): AccessClaims {
  const audience = typeof payload.aud === "string" ? [payload.aud] : payload.aud;
  if (!audience?.length) throw new Error("missing audience");
  return {
    aud: audience,
    email: typeof payload.email === "string" ? payload.email : undefined,
    common_name: typeof payload.common_name === "string" ? payload.common_name : undefined,
    sub: payload.sub,
  };
}

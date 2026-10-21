import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";

/**
 * Embed trust bridge.
 *
 * Two credentials are involved and must not be confused:
 *
 *   1. The per-tenant **embed secret** (`cmembed_…`). The client's backend keeps
 *      it server-side and presents it to POST /api/embed/token to prove it may
 *      act for that tenant. ClinicMind stores only its SHA-256 hash and shows
 *      the plaintext once, at (re)generation.
 *   2. The platform-wide `EMBED_SIGNING_SECRET`, which signs the short-lived
 *      **embed token** (JWT) the token endpoint returns. The token identifies
 *      the tenant, the acting user, their (capped) role and the framing origin;
 *      ClinicMind verifies it on the /embed surface and at the API edge.
 */

// ── Embed secret (per tenant) ────────────────────────────────────────────────

export const EMBED_SECRET_PREFIX = "cmembed_";
/** Request header the token endpoint reads the embed secret from. */
export const EMBED_SECRET_HEADER = "x-clinicmind-embed-secret";
/** Number of leading characters (after the prefix) that are safe to display. */
const SECRET_DISPLAY_CHARS = 6;

export interface GeneratedEmbedSecret {
  /** Plaintext secret — return it to the caller once, never persist it. */
  secret: string;
  /** SHA-256 hex digest to persist. */
  hash: string;
  /** Non-secret identifier (`cmembed_` + first characters) for display. */
  prefix: string;
}

/** Generate a new embed secret with 256 bits of CSPRNG entropy. */
export function generateEmbedSecret(): GeneratedEmbedSecret {
  const secret = `${EMBED_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { secret, hash: hashEmbedSecret(secret), prefix: embedSecretPrefix(secret) };
}

export function hashEmbedSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function embedSecretPrefix(secret: string): string {
  return secret.slice(0, EMBED_SECRET_PREFIX.length + SECRET_DISPLAY_CHARS);
}

/**
 * Constant-time check of a presented secret against the stored hash. Hashing
 * first means both sides are fixed-length digests, so `timingSafeEqual` never
 * leaks the secret length or a prefix match.
 */
export function embedSecretMatches(
  presented: string | null | undefined,
  storedHash: string | null | undefined,
): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(hashEmbedSecret(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Origins ──────────────────────────────────────────────────────────────────

/** Normalize to `scheme://host[:port]`; null for anything that is not http(s). */
export function normalizeOrigin(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Exact-origin allow-list check. An empty allow-list permits nothing. */
export function isOriginAllowed(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): boolean {
  const candidate = normalizeOrigin(origin);
  if (!candidate) return false;
  return allowedOrigins.some((allowed) => normalizeOrigin(allowed) === candidate);
}

// ── Embed token (platform-signed JWT) ────────────────────────────────────────

const secret = new TextEncoder().encode(env.EMBED_SIGNING_SECRET);

export interface EmbedClaims {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  /**
   * A tenant role (never SUPER_ADMIN). Treated as untrusted input until the
   * session layer confirms it does not exceed the user's stored role.
   */
  role: string;
  /** Origin permitted to frame this session (for CSP frame-ancestors). */
  origin?: string;
}

export async function signEmbedToken(claims: EmbedClaims, ttlSeconds = 600): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setIssuer("clinicmind")
    .setAudience("clinicmind-embed")
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret);
}

export async function verifyEmbedToken(token: string): Promise<EmbedClaims> {
  const { payload } = await jwtVerify(token, secret, {
    issuer: "clinicmind",
    audience: "clinicmind-embed",
  });
  return {
    tenantId: String(payload.tenantId),
    tenantSlug: String(payload.tenantSlug),
    userId: String(payload.userId),
    role: String(payload.role),
    origin: payload.origin ? String(payload.origin) : undefined,
  };
}

/**
 * Build the `frame-ancestors` CSP directive for a tenant's embed surface from
 * its allow-list. Empty list => deny all framing (same-origin only).
 */
export function frameAncestorsDirective(allowedOrigins: string[]): string {
  if (!allowedOrigins.length) return "frame-ancestors 'self'";
  return `frame-ancestors 'self' ${allowedOrigins.join(" ")}`;
}

import { SignJWT, jwtVerify } from "jose";
import { env } from "@/lib/env";

/**
 * Embed token signing/verification.
 *
 * When a client embeds ClinicMind on their own website (or the GROW Engine host
 * dashboard frames the admin tab), the host signs a short-lived JWT identifying
 * the tenant, the acting user and their role. ClinicMind verifies it on the
 * /embed surface and at the API edge — this is the trust bridge that lets each
 * client run their own version under their own domain with their own session.
 */

const secret = new TextEncoder().encode(env.EMBED_SIGNING_SECRET);

export interface EmbedClaims {
  tenantId: string;
  tenantSlug: string;
  userId: string;
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

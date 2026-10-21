import { createHmac, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Opaque bearer tokens (sessions, invitation and reset links).
 *
 * The raw token is handed to the client exactly once. The database stores only
 * `HMAC-SHA256(AUTH_SECRET, purpose || token)`, so a leaked table cannot be
 * replayed without the server secret, and rotating AUTH_SECRET invalidates every
 * outstanding session and link at once.
 */
export type TokenPurpose = "session" | "auth-token";

/** 256 bits of randomness, URL-safe (43 characters). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string, purpose: TokenPurpose): string {
  return createHmac("sha256", env.AUTH_SECRET).update(`${purpose}:${token}`).digest("hex");
}

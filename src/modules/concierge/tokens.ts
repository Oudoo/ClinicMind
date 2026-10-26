import { generateToken, hashToken, type TokenPurpose } from "@/lib/auth/tokens";
import { env } from "@/lib/env";

/**
 * Check-in link tokens. The raw token travels once, inside the patient's
 * message; `ConciergeTask.tokenHash` stores only `hashToken(token, "check-in")`.
 * Every send (first message, reminder, manual re-send) mints a fresh token, so
 * the latest link is the valid one.
 *
 * "check-in" is not in `TokenPurpose` yet (shared file, owned by the
 * integrator): the cast keeps the HMAC domain separated from sessions and
 * auth links exactly as the type would once it is added.
 */
const CHECK_IN_PURPOSE = "check-in" as unknown as TokenPurpose;

export function newCheckInToken(): string {
  return generateToken();
}

export function checkInTokenHash(token: string): string {
  return hashToken(token, CHECK_IN_PURPOSE);
}

/** Public base URL for patient links (PUBLIC_URL, else APP_URL). */
export function publicBaseUrl(): string {
  return (env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, "");
}

export function checkInLink(token: string): string {
  return `${publicBaseUrl()}/check-in/${token}`;
}

/** Tokens are 43 URL-safe characters; anything else is refused before the database is asked. */
export function looksLikeToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{20,128}$/.test(token);
}

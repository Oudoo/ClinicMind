import { generateToken, hashToken } from "@/lib/auth/tokens";

/**
 * Onboarding-link tokens: 256 random bits in the URL, only the keyed hash in
 * `IntakeLink.tokenHash` (the same HMAC as invitation and reset links), and
 * the first eight characters kept as `tokenPrefix` so staff can tell links
 * apart without the token. Shared by the intake service and the demo seed so
 * both store exactly what the public endpoint looks up.
 */
const TOKEN_PURPOSE = "auth-token" as const;

export function hashIntakeToken(token: string): string {
  return hashToken(token, TOKEN_PURPOSE);
}

export interface IssuedIntakeToken {
  /** Shown once (in the URL and the QR); never stored. */
  token: string;
  tokenHash: string;
  tokenPrefix: string;
}

export function issueIntakeToken(): IssuedIntakeToken {
  const token = generateToken();
  return { token, tokenHash: hashIntakeToken(token), tokenPrefix: token.slice(0, 8) };
}

/** Shape check before any database lookup: base64url, 16–128 characters. */
export function isPlausibleIntakeToken(token: string): boolean {
  return Boolean(token) && token.length >= 16 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}

import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./constants";

/**
 * Password hashing (argon2id) and the password policy.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for
 * argon2id (19 MiB memory, 2 iterations, 1 lane). The hash string encodes its
 * own parameters, so they can be raised later without invalidating stored
 * hashes; `argon2.verify` reads them back from the hash.
 *
 * This module has no dependency on the env schema or the database so that
 * `prisma/seed.ts` can import it directly.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash. A missing hash (user has not
 * accepted their invitation yet) still burns a full argon2 verification so the
 * response time does not reveal whether the account has a password.
 */
export async function verifyPassword(
  hash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (!hash) {
    await verifyDummyPassword();
    return false;
  }
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed hash: treat as a mismatch rather than leaking the error.
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/**
 * Spend the same CPU time as a real verification. Used when no user matches
 * the submitted e-mail so that "unknown account" and "wrong password" are
 * indistinguishable by timing.
 */
export async function verifyDummyPassword(): Promise<void> {
  dummyHash ??= argon2.hash(randomBytes(16).toString("hex"), ARGON2_OPTIONS);
  await argon2.verify(await dummyHash, "not-the-password").catch(() => undefined);
}

/** Random, policy-compliant password for seeds and tooling (base64url, 16+ chars). */
export function generatePassword(bytes = 12): string {
  return randomBytes(bytes).toString("base64url");
}

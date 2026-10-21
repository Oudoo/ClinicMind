import { describe, it, expect } from "vitest";
import { generatePassword, hashPassword, PasswordSchema, verifyPassword } from "@/lib/auth/password";

describe("password hashing", () => {
  it("round-trips through argon2id", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(hash, "Correct horse battery staple")).toBe(false);
  });

  it("treats a missing or malformed hash as a mismatch", async () => {
    expect(await verifyPassword(null, "anything")).toBe(false);
    expect(await verifyPassword(undefined, "anything")).toBe(false);
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("enforces the length policy", () => {
    expect(PasswordSchema.safeParse("tooshort").success).toBe(false);
    expect(PasswordSchema.safeParse("a".repeat(12)).success).toBe(true);
    expect(PasswordSchema.safeParse("a".repeat(129)).success).toBe(false);
    expect(PasswordSchema.safeParse(generatePassword()).success).toBe(true);
  });
});

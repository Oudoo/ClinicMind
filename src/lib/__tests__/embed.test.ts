import { describe, it, expect } from "vitest";
import {
  EMBED_SECRET_PREFIX,
  embedSecretMatches,
  embedSecretPrefix,
  generateEmbedSecret,
  hashEmbedSecret,
  isOriginAllowed,
  normalizeOrigin,
  signEmbedToken,
  verifyEmbedToken,
} from "@/lib/embed";

describe("embed secret (SEC-2)", () => {
  it("generates a prefixed, high-entropy secret and only a hash to store", () => {
    const a = generateEmbedSecret();
    const b = generateEmbedSecret();
    expect(a.secret.startsWith(EMBED_SECRET_PREFIX)).toBe(true);
    expect(a.secret.length).toBeGreaterThanOrEqual(EMBED_SECRET_PREFIX.length + 43); // 32 bytes base64url
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(hashEmbedSecret(a.secret));
    expect(a.hash).not.toContain(a.secret);
    expect(a.prefix).toBe(embedSecretPrefix(a.secret));
    expect(a.prefix).toBe(a.secret.slice(0, EMBED_SECRET_PREFIX.length + 6));
    expect(a.secret.startsWith(a.prefix)).toBe(true);
  });

  it("matches only the exact secret against the stored hash", () => {
    const { secret, hash } = generateEmbedSecret();
    expect(embedSecretMatches(secret, hash)).toBe(true);
    expect(embedSecretMatches(secret.slice(0, -1), hash)).toBe(false);
    expect(embedSecretMatches(`${secret}x`, hash)).toBe(false);
    expect(embedSecretMatches(generateEmbedSecret().secret, hash)).toBe(false);
  });

  it("never matches when either side is missing or malformed", () => {
    const { secret, hash } = generateEmbedSecret();
    expect(embedSecretMatches(null, hash)).toBe(false);
    expect(embedSecretMatches("", hash)).toBe(false);
    expect(embedSecretMatches(secret, null)).toBe(false);
    expect(embedSecretMatches(secret, "")).toBe(false);
    expect(embedSecretMatches(secret, "not-hex")).toBe(false);
    expect(embedSecretMatches(secret, hash.slice(0, 32))).toBe(false);
    // A stored *plaintext* (the old scheme) must not match either.
    expect(embedSecretMatches(secret, secret)).toBe(false);
  });
});

describe("origin allow-list", () => {
  it("normalizes to scheme + host + port", () => {
    expect(normalizeOrigin("https://care.acme.com/some/path?x=1#y")).toBe("https://care.acme.com");
    expect(normalizeOrigin("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(normalizeOrigin("HTTPS://Care.Acme.com")).toBe("https://care.acme.com");
  });

  it("rejects non-http(s) and malformed values", () => {
    expect(normalizeOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeOrigin("file:///etc/passwd")).toBeNull();
    expect(normalizeOrigin("not a url")).toBeNull();
    expect(normalizeOrigin("")).toBeNull();
    expect(normalizeOrigin(null)).toBeNull();
  });

  it("requires an exact origin match and permits nothing on an empty list", () => {
    const allowed = ["https://care.acme.com", "http://localhost:3000/"];
    expect(isOriginAllowed("https://care.acme.com", allowed)).toBe(true);
    expect(isOriginAllowed("https://care.acme.com/page", allowed)).toBe(true);
    expect(isOriginAllowed("http://localhost:3000", allowed)).toBe(true);
    expect(isOriginAllowed("https://evil.acme.com", allowed)).toBe(false);
    expect(isOriginAllowed("https://care.acme.com.evil.example", allowed)).toBe(false);
    expect(isOriginAllowed("http://care.acme.com", allowed)).toBe(false); // scheme matters
    expect(isOriginAllowed("https://care.acme.com:8443", allowed)).toBe(false); // port matters
    expect(isOriginAllowed("https://care.acme.com", [])).toBe(false);
    expect(isOriginAllowed(undefined, allowed)).toBe(false);
  });
});

describe("embed token", () => {
  it("round-trips the claims", async () => {
    const token = await signEmbedToken(
      { tenantId: "t1", tenantSlug: "acme", userId: "u1", role: "DOCTOR", origin: "https://care.acme.com" },
      120,
    );
    const claims = await verifyEmbedToken(token);
    expect(claims).toEqual({
      tenantId: "t1",
      tenantSlug: "acme",
      userId: "u1",
      role: "DOCTOR",
      origin: "https://care.acme.com",
    });
  });

  it("rejects tampered tokens", async () => {
    const token = await signEmbedToken({ tenantId: "t1", tenantSlug: "acme", userId: "u1", role: "DOCTOR" });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const forged = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), role: "SUPER_ADMIN" })).toString("base64url")}.${signature}`;
    await expect(verifyEmbedToken(forged)).rejects.toThrow();
  });
});

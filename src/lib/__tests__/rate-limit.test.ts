import { beforeEach, describe, expect, it } from "vitest";
import { rateLimit, resetRateLimits } from "@/lib/auth/rate-limit";

const WINDOW = 60_000;

describe("rate limiter", () => {
  beforeEach(() => resetRateLimits());

  it("allows up to the limit, then blocks with a retry hint", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = rateLimit("k", 3, WINDOW, t0 + i);
      expect(r.ok).toBe(true);
      expect(r.remaining).toBe(2 - i);
    }
    const blocked = rateLimit("k", 3, WINDOW, t0 + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBe(Math.ceil((WINDOW - 10) / 1000));
  });

  it("forgets attempts that left the window", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i++) rateLimit("k", 3, WINDOW, t0);
    expect(rateLimit("k", 3, WINDOW, t0 + WINDOW - 1).ok).toBe(false);
    expect(rateLimit("k", 3, WINDOW, t0 + WINDOW).ok).toBe(true);
  });

  it("keeps keys independent", () => {
    for (let i = 0; i < 3; i++) rateLimit("ip:a", 3, WINDOW);
    expect(rateLimit("ip:a", 3, WINDOW).ok).toBe(false);
    expect(rateLimit("ip:b", 3, WINDOW).ok).toBe(true);
  });
});

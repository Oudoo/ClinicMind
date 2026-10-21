/**
 * Minimal in-memory sliding-window rate limiter for the authentication
 * endpoints (sign-in, password reset, set-password).
 *
 * State is per process. That is enough to blunt online password guessing on a
 * single instance and it needs no infrastructure; a horizontally scaled
 * deployment should move the buckets to Redis (REDIS_URL is already
 * provisioned). The per-account lockout in lib/auth/login.ts is database-backed
 * and therefore shared across instances regardless.
 */
export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the oldest counted attempt leaves the window (0 when ok). */
  retryAfterSeconds: number;
}

const buckets = new Map<string, number[]>();
const MAX_KEYS = 10_000;
let callsSincePrune = 0;

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const since = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > since);

  if (hits.length >= limit) {
    buckets.set(key, hits);
    const retryAfterSeconds = Math.max(1, Math.ceil((hits[0]! + windowMs - now) / 1000));
    return { ok: false, remaining: 0, retryAfterSeconds };
  }

  hits.push(now);
  buckets.set(key, hits);
  if (++callsSincePrune >= 1000 || buckets.size > MAX_KEYS) prune(now, windowMs);
  return { ok: true, remaining: limit - hits.length, retryAfterSeconds: 0 };
}

function prune(now: number, windowMs: number): void {
  callsSincePrune = 0;
  for (const [key, hits] of buckets) {
    if (!hits.some((t) => t > now - windowMs)) buckets.delete(key);
  }
}

/** Test hook: forget every bucket. */
export function resetRateLimits(): void {
  buckets.clear();
  callsSincePrune = 0;
}

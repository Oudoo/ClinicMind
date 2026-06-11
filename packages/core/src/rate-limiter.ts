import { redis } from "./redis.js";

/**
 * API Rate Limit Manager — Redis sliding-window limiter with exponential
 * backoff persistence per provider, shared between web and workers so the
 * platform never exceeds provider quotas.
 */

interface ProviderLimit {
  /** Max requests per window */
  limit: number;
  /** Window length in seconds */
  windowSeconds: number;
}

const PROVIDER_LIMITS: Record<string, ProviderLimit> = {
  meta: { limit: 200, windowSeconds: 3600 },
  ga4: { limit: 1200, windowSeconds: 3600 },
  google_ads: { limit: 1000, windowSeconds: 3600 },
  tiktok: { limit: 600, windowSeconds: 60 },
  linkedin: { limit: 100, windowSeconds: 60 },
  x: { limit: 75, windowSeconds: 900 },
  zoho_crm: { limit: 100, windowSeconds: 60 },
  hubspot: { limit: 110, windowSeconds: 10 },
  salesforce: { limit: 1000, windowSeconds: 3600 },
  dynamics: { limit: 500, windowSeconds: 300 },
  odoo: { limit: 300, windowSeconds: 60 },
  default: { limit: 60, windowSeconds: 60 },
};

export class RateLimitError extends Error {
  constructor(
    public provider: string,
    public retryAfterMs: number
  ) {
    super(`Rate limit reached for ${provider}; retry after ${retryAfterMs}ms`);
    this.name = "RateLimitError";
  }
}

/** Acquire a request slot or throw RateLimitError with a retry hint. */
export async function acquireSlot(provider: string, tenantId: string): Promise<void> {
  const cfg = PROVIDER_LIMITS[provider] ?? PROVIDER_LIMITS.default;
  const backoffKey = `ratelimit:backoff:${provider}:${tenantId}`;
  const backoffUntil = await redis.get(backoffKey);
  if (backoffUntil && Number(backoffUntil) > Date.now()) {
    throw new RateLimitError(provider, Number(backoffUntil) - Date.now());
  }

  const windowKey = `ratelimit:window:${provider}:${tenantId}`;
  const now = Date.now();
  const windowStart = now - cfg.windowSeconds * 1000;

  const multi = redis.multi();
  multi.zremrangebyscore(windowKey, 0, windowStart);
  multi.zcard(windowKey);
  const results = await multi.exec();
  const count = Number(results?.[1]?.[1] ?? 0);

  if (count >= cfg.limit) {
    const oldest = await redis.zrange(windowKey, 0, 0, "WITHSCORES");
    const retryAfter = oldest.length >= 2 ? Number(oldest[1]) + cfg.windowSeconds * 1000 - now : 30_000;
    throw new RateLimitError(provider, Math.max(retryAfter, 1000));
  }

  await redis.zadd(windowKey, now, `${now}:${Math.random()}`);
  await redis.expire(windowKey, cfg.windowSeconds + 60);
}

/** Record a provider 429/throttle and set exponential backoff. */
export async function recordThrottle(provider: string, tenantId: string): Promise<number> {
  const countKey = `ratelimit:throttles:${provider}:${tenantId}`;
  const throttles = await redis.incr(countKey);
  await redis.expire(countKey, 3600);
  const backoffMs = Math.min(2 ** throttles * 1000, 15 * 60 * 1000);
  await redis.set(
    `ratelimit:backoff:${provider}:${tenantId}`,
    String(Date.now() + backoffMs),
    "PX",
    backoffMs
  );
  return backoffMs;
}

export async function clearBackoff(provider: string, tenantId: string) {
  await redis.del(
    `ratelimit:backoff:${provider}:${tenantId}`,
    `ratelimit:throttles:${provider}:${tenantId}`
  );
}

/**
 * Rate-limited fetch wrapper used by every integration connector.
 * Retries on 429/5xx with provider-aware backoff and surfaces the
 * provider request id for the Verifiable Data Layer.
 */
export async function rateLimitedFetch(
  provider: string,
  tenantId: string,
  url: string,
  init?: RequestInit,
  maxRetries = 4
): Promise<{ response: Response; requestId: string | null }> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireSlot(provider, tenantId);
    const response = await fetch(url, init);

    const requestId =
      response.headers.get("x-fb-trace-id") ??
      response.headers.get("x-fb-debug") ??
      response.headers.get("x-request-id") ??
      response.headers.get("x-amzn-requestid") ??
      response.headers.get("request-id") ??
      null;

    if (response.status === 429 || response.status === 503) {
      const backoffMs = await recordThrottle(provider, tenantId);
      lastError = new Error(`${provider} throttled (HTTP ${response.status})`);
      await new Promise((r) => setTimeout(r, Math.min(backoffMs, 30_000)));
      continue;
    }

    if (response.ok) {
      await clearBackoff(provider, tenantId);
    }
    return { response, requestId };
  }
  throw lastError ?? new Error(`${provider} request failed after ${maxRetries} retries`);
}

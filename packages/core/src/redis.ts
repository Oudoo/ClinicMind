import { Redis } from "ioredis";
import { env } from "./env.js";

declare global {
  // eslint-disable-next-line no-var
  var __growengine_redis: Redis | undefined;
}

/** Shared Redis connection for caching / rate limiting. */
export const redis: Redis =
  globalThis.__growengine_redis ??
  new Redis(env.redisUrl, { maxRetriesPerRequest: 2, lazyConnect: false });

if (env.nodeEnv !== "production") {
  globalThis.__growengine_redis = redis;
}

/**
 * Connection options for BullMQ (which bundles its own ioredis). Plain
 * options avoid cross-package ioredis type conflicts and let BullMQ manage
 * its own connections (maxRetriesPerRequest: null is required by BullMQ).
 */
export function bullConnectionOptions() {
  const url = new URL(env.redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname && url.pathname !== "/" ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null as null,
  };
}

/** Simple JSON cache helpers over Redis. */
export async function cacheGet<T>(keyName: string): Promise<T | null> {
  const raw = await redis.get(keyName);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function cacheSet(keyName: string, value: unknown, ttlSeconds: number) {
  await redis.set(keyName, JSON.stringify(value), "EX", ttlSeconds);
}

export async function cacheDelete(pattern: string) {
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(...keys);
}

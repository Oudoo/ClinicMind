import { sql as dsql } from "drizzle-orm";
import { db } from "@growengine/db";
import { redis } from "./redis.js";
import { getQueueStats } from "./queues.js";

/**
 * System Health Dashboard data source — worker status, queue depth,
 * failed jobs, database and Redis health.
 */
export interface SystemHealth {
  database: { ok: boolean; latencyMs: number };
  redis: { ok: boolean; latencyMs: number };
  queues: Record<string, { waiting: number; active: number; failed: number; delayed: number; completed: number }>;
  workers: { name: string; lastHeartbeat: string | null; healthy: boolean }[];
  checkedAt: string;
}

const WORKER_NAMES = ["integration", "ai", "research", "notification", "events"];

export async function getSystemHealth(): Promise<SystemHealth> {
  const dbStart = Date.now();
  let dbOk = true;
  try {
    await db.execute(dsql`SELECT 1`);
  } catch {
    dbOk = false;
  }
  const dbLatency = Date.now() - dbStart;

  const redisStart = Date.now();
  let redisOk = true;
  try {
    await redis.ping();
  } catch {
    redisOk = false;
  }
  const redisLatency = Date.now() - redisStart;

  let queues: SystemHealth["queues"] = {};
  try {
    queues = await getQueueStats();
  } catch {
    /* queue stats unavailable when redis is down */
  }

  const workers: SystemHealth["workers"] = [];
  for (const name of WORKER_NAMES) {
    let lastHeartbeat: string | null = null;
    try {
      lastHeartbeat = await redis.get(`worker:heartbeat:${name}`);
    } catch {
      /* redis down */
    }
    const healthy =
      !!lastHeartbeat && Date.now() - new Date(lastHeartbeat).getTime() < 120_000;
    workers.push({ name, lastHeartbeat, healthy });
  }

  return {
    database: { ok: dbOk, latencyMs: dbLatency },
    redis: { ok: redisOk, latencyMs: redisLatency },
    queues,
    workers,
    checkedAt: new Date().toISOString(),
  };
}

/** Workers call this every 30s. */
export async function recordHeartbeat(workerName: string) {
  await redis.set(`worker:heartbeat:${workerName}`, new Date().toISOString(), "EX", 300);
}

import { Queue, type JobsOptions } from "bullmq";
import { bullConnectionOptions } from "./redis.js";
import { db, queueJobs } from "@growengine/db";

/**
 * The Golden Architectural Rule: heavy processing never runs inside the
 * Next.js request cycle. Everything below is the only sanctioned path for
 * AI work, syncs, crawling, reporting and notifications.
 */
export const QUEUE_NAMES = {
  integration: "integration",
  ai: "ai",
  research: "research",
  notification: "notification",
  events: "events",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface IntegrationJobData {
  tenantId: string;
  integrationId: string;
  operation: "sync" | "refresh_token" | "health_check" | "backfill";
  options?: { since?: string; until?: string };
}

export interface AiJobData {
  tenantId: string;
  aiJobId: string;
  jobType:
    | "report"
    | "dmaic"
    | "aeo_audit"
    | "meeting_analysis"
    | "sow"
    | "recommendation_verify"
    | "forecast"
    | "embedding"
    | "lead_audit"
    | "qbr"
    | "digest"
    | "lost_opportunity"
    | "seasonality"
    | "process_intelligence"
    | "health_score"
    | "scorecards"
    | "retention_enforcement";
  input: Record<string, unknown>;
}

export interface ResearchJobData {
  tenantId: string;
  clientId?: string;
  operation: "competitor_analysis" | "web_crawl" | "pr_mentions" | "rss_monitor";
  input: Record<string, unknown>;
}

export interface NotificationJobData {
  tenantId: string;
  notificationId?: string;
  kind: "dispatch" | "digest_weekly" | "digest_monthly" | "onboarding_drip" | "webhook_delivery";
  input: Record<string, unknown>;
}

export interface DomainEventJobData {
  domainEventId: string;
  tenantId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 5_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

declare global {
  // eslint-disable-next-line no-var
  var __growengine_queues: Map<QueueName, Queue> | undefined;
}

const queueCache: Map<QueueName, Queue> =
  globalThis.__growengine_queues ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__growengine_queues = queueCache;
}

export function getQueue(name: QueueName): Queue {
  let q = queueCache.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: bullConnectionOptions(),
      defaultJobOptions,
    });
    queueCache.set(name, q);
  }
  return q;
}

/** Enqueue + mirror into queue_jobs for the System Health Dashboard. */
async function enqueue(
  queueName: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  tenantId: string | null,
  opts?: JobsOptions
) {
  const job = await getQueue(queueName).add(jobName, data, opts);
  await db.insert(queueJobs).values({
    tenantId,
    queueName,
    jobName,
    bullJobId: String(job.id),
    status: "waiting",
    payloadSummary: summarize(data),
  });
  return job;
}

function summarize(data: Record<string, unknown>) {
  const { tenantId, ...rest } = data;
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    summary[k] = typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}…` : v;
  }
  return summary;
}

export const enqueueIntegrationJob = (data: IntegrationJobData, opts?: JobsOptions) =>
  enqueue(QUEUE_NAMES.integration, data.operation, data as unknown as Record<string, unknown>, data.tenantId, opts);

export const enqueueAiJob = (data: AiJobData, opts?: JobsOptions) =>
  enqueue(QUEUE_NAMES.ai, data.jobType, data as unknown as Record<string, unknown>, data.tenantId, opts);

export const enqueueResearchJob = (data: ResearchJobData, opts?: JobsOptions) =>
  enqueue(QUEUE_NAMES.research, data.operation, data as unknown as Record<string, unknown>, data.tenantId, opts);

export const enqueueNotificationJob = (data: NotificationJobData, opts?: JobsOptions) =>
  enqueue(QUEUE_NAMES.notification, data.kind, data as unknown as Record<string, unknown>, data.tenantId, opts);

export const enqueueDomainEvent = (data: DomainEventJobData, opts?: JobsOptions) =>
  enqueue(QUEUE_NAMES.events, data.eventType, data as unknown as Record<string, unknown>, data.tenantId, opts);

/** Queue stats for the System Health Dashboard. */
export async function getQueueStats() {
  const stats: Record<string, { waiting: number; active: number; failed: number; delayed: number; completed: number }> = {};
  for (const name of Object.values(QUEUE_NAMES)) {
    const q = getQueue(name);
    const counts = await q.getJobCounts("waiting", "active", "failed", "delayed", "completed");
    stats[name] = {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
    };
  }
  return stats;
}

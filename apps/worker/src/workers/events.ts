import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db, domainEvents, integrations, forecasts } from "@growengine/db";
import {
  bullConnectionOptions,
  QUEUE_NAMES,
  EVENT_TYPES,
  enqueueAiJob,
  enqueueNotificationJob,
  applyNotificationRules,
  notify,
  type DomainEventJobData,
} from "@growengine/core";
import { markJobStatus } from "../lib/track.js";

/**
 * Events Worker — the Domain Event Layer fan-out. Decouples producers
 * from consumers: a completed Meta sync triggers forecast refreshes,
 * health-score refreshes and digests without any module knowing about
 * the others.
 */

type Handler = (tenantId: string, payload: Record<string, unknown>) => Promise<void>;

const handlers: Record<string, Handler[]> = {
  [EVENT_TYPES.integrationSyncCompleted]: [
    // Refresh downstream intelligence whenever fresh data lands
    async (tenantId, payload) => {
      const clientId = payload.clientId as string;
      if (!clientId) return;
      for (const metric of ["spend", "conversions", "revenue", "leads"]) {
        // Only refresh forecasts that already exist for this metric
        const existing = await db
          .select({ id: forecasts.id, metric: forecasts.metric, horizonDays: forecasts.horizonDays })
          .from(forecasts)
          .where(eq(forecasts.clientId, clientId));
        const latest = existing.filter((f) => f.metric === metric).pop();
        if (latest) {
          const [row] = await db
            .insert(forecasts)
            .values({
              tenantId,
              clientId,
              metric,
              horizonDays: latest.horizonDays,
              status: "queued",
            })
            .returning();
          await enqueueAiJob({
            tenantId,
            aiJobId: "",
            jobType: "forecast",
            input: { clientId, metric, horizonDays: latest.horizonDays, forecastId: row.id },
          });
        }
      }
      await enqueueAiJob({
        tenantId,
        aiJobId: "",
        jobType: "health_score",
        input: { clientId },
      });
    },
  ],
  [EVENT_TYPES.integrationFailed]: [
    async (tenantId, payload) => {
      // Alert internal team about failing integrations
      const [integration] = payload.integrationId
        ? await db
            .select()
            .from(integrations)
            .where(eq(integrations.id, payload.integrationId as string))
        : [];
      await notify({
        tenantId,
        channel: "slack",
        title: `Integration failure: ${payload.provider}`,
        body: `Error: ${payload.error}${integration ? ` (integration ${integration.name})` : ""}`,
        metadata: payload,
      });
    },
  ],
  [EVENT_TYPES.milestoneReached]: [
    async (tenantId, payload) => {
      await notify({
        tenantId,
        channel: "slack",
        title: `🎉 Client milestone reached: ${payload.label}`,
        body: `Client ${payload.clientId} hit ${payload.metric} target of ${payload.target}.`,
        metadata: payload,
      });
    },
  ],
};

export function createEventsWorker() {
  const worker = new Worker<DomainEventJobData>(
    QUEUE_NAMES.events,
    async (job: Job<DomainEventJobData>) => {
      await markJobStatus(job, "active");
      const { domainEventId, tenantId, eventType, payload } = job.data;
      const results: { handler: string; ok: boolean; error?: string }[] = [];

      // 1. Built-in event handlers
      for (const [index, handler] of (handlers[eventType] ?? []).entries()) {
        try {
          if (tenantId) await handler(tenantId, payload);
          results.push({ handler: `builtin_${index}`, ok: true });
        } catch (err) {
          results.push({ handler: `builtin_${index}`, ok: false, error: (err as Error).message });
        }
      }

      // 2. Tenant-configured notification rules
      if (tenantId) {
        try {
          await applyNotificationRules(tenantId, eventType, payload);
          results.push({ handler: "notification_rules", ok: true });
        } catch (err) {
          results.push({ handler: "notification_rules", ok: false, error: (err as Error).message });
        }

        // 3. Outbound webhooks
        try {
          await enqueueNotificationJob({
            tenantId,
            kind: "webhook_delivery",
            input: { eventType, payload },
          });
          results.push({ handler: "webhooks", ok: true });
        } catch (err) {
          results.push({ handler: "webhooks", ok: false, error: (err as Error).message });
        }
      }

      await db
        .update(domainEvents)
        .set({
          dispatchStatus: results.every((r) => r.ok) ? "dispatched" : "failed",
          handlerResults: results,
          dispatchedAt: new Date(),
        })
        .where(eq(domainEvents.id, domainEventId));
    },
    { connection: bullConnectionOptions(), concurrency: 5 }
  );
  worker.on("completed", (job) => markJobStatus(job, "completed"));
  worker.on("failed", (job, err) => job && markJobStatus(job, "failed", err.message));
  return worker;
}

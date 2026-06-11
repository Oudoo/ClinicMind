import { Worker, type Job } from "bullmq";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import { createHmac } from "node:crypto";
import {
  db,
  clients,
  users,
  webhookEndpoints,
  webhookDeliveries,
} from "@growengine/db";
import {
  bullConnectionOptions,
  QUEUE_NAMES,
  deliverNotification,
  enqueueAiJob,
  decryptSecret,
  notify,
  type NotificationJobData,
} from "@growengine/core";
import { markJobStatus } from "../lib/track.js";

/**
 * Notification Worker — emails, onboarding drips, alerts, outbound
 * webhooks and scheduled digests.
 */

async function handleDispatch(data: NotificationJobData) {
  if (!data.notificationId) return;
  await deliverNotification(data.notificationId);
}

/** Scheduled fan-out: enqueue a digest AI job per active client. */
async function handleDigestSchedule(data: NotificationJobData, period: "weekly" | "monthly") {
  const activeClients = await db
    .select()
    .from(clients)
    .where(and(eq(clients.tenantId, data.tenantId), eq(clients.status, "active")));
  for (const client of activeClients) {
    await enqueueAiJob({
      tenantId: data.tenantId,
      aiJobId: "",
      jobType: "digest",
      input: { clientId: client.id, period },
    });
  }
}

/** Automated onboarding drip — day-indexed welcome sequence for portal users. */
const ONBOARDING_DRIP: { day: number; title: string; body: string }[] = [
  {
    day: 0,
    title: "Welcome to your Grow Engine portal",
    body: "Your portal is live. You'll find your KPI dashboard, milestones, approvals and reports here. Every number you see links back to its exact data source.",
  },
  {
    day: 2,
    title: "How creative approvals work",
    body: "When we prepare new ad creatives you'll get an approval request in the portal. Once you sign off, we run a 7-day micro-budget pilot before scaling anything.",
  },
  {
    day: 5,
    title: "Your weekly digest is coming",
    body: "Every week you'll receive a KPI digest comparing this period to the last, with what changed and what we're focusing on next.",
  },
  {
    day: 10,
    title: "Recommendations, decisions and the paper trail",
    body: "Every recommendation we make is verified against your real data and carries a confidence score. Your decisions are recorded so we always know what was agreed and why.",
  },
];

async function handleOnboardingDrip(data: NotificationJobData) {
  const { userId, dayIndex } = data.input as { userId: string; dayIndex: number };
  const step = ONBOARDING_DRIP.find((s) => s.day === dayIndex);
  if (!step) return;
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.tenantId, data.tenantId)));
  if (!user || user.status !== "active") return;

  await notify({
    tenantId: data.tenantId,
    userId,
    channel: "in_app",
    title: step.title,
    body: step.body,
  });
  await notify({
    tenantId: data.tenantId,
    userId,
    channel: "email",
    title: step.title,
    body: step.body,
    metadata: { email: user.email },
  });
}

/** Outbound platform webhooks with HMAC signatures + retry accounting. */
async function handleWebhookDelivery(data: NotificationJobData) {
  const { eventType, payload } = data.input as {
    eventType: string;
    payload: Record<string, unknown>;
  };
  const endpoints = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.tenantId, data.tenantId), eq(webhookEndpoints.isActive, 1)));

  for (const endpoint of endpoints) {
    const types = endpoint.eventTypes as string[];
    if (!types.includes("*") && !types.includes(eventType)) continue;

    const [delivery] = await db
      .insert(webhookDeliveries)
      .values({
        tenantId: data.tenantId,
        endpointId: endpoint.id,
        eventType,
        payload,
      })
      .returning();

    const body = JSON.stringify({ event: eventType, payload, deliveryId: delivery.id });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (endpoint.encryptedSecret) {
      const secret = decryptSecret(endpoint.encryptedSecret);
      headers["X-GrowEngine-Signature"] = createHmac("sha256", secret).update(body).digest("hex");
    }

    try {
      const res = await fetch(endpoint.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(15_000),
      });
      await db
        .update(webhookDeliveries)
        .set({
          responseStatus: res.status,
          status: res.ok ? "delivered" : "failed",
          attempts: dsql`${webhookDeliveries.attempts} + 1`,
          deliveredAt: res.ok ? new Date() : null,
        })
        .where(eq(webhookDeliveries.id, delivery.id));
    } catch {
      await db
        .update(webhookDeliveries)
        .set({ status: "failed", attempts: dsql`${webhookDeliveries.attempts} + 1` })
        .where(eq(webhookDeliveries.id, delivery.id));
    }
  }
}

export function createNotificationWorker() {
  const worker = new Worker<NotificationJobData>(
    QUEUE_NAMES.notification,
    async (job: Job<NotificationJobData>) => {
      await markJobStatus(job, "active");
      switch (job.data.kind) {
        case "dispatch":
          return handleDispatch(job.data);
        case "digest_weekly":
          return handleDigestSchedule(job.data, "weekly");
        case "digest_monthly":
          return handleDigestSchedule(job.data, "monthly");
        case "onboarding_drip":
          return handleOnboardingDrip(job.data);
        case "webhook_delivery":
          return handleWebhookDelivery(job.data);
      }
    },
    { connection: bullConnectionOptions(), concurrency: 5 }
  );
  worker.on("completed", (job) => markJobStatus(job, "completed"));
  worker.on("failed", (job, err) => job && markJobStatus(job, "failed", err.message));
  return worker;
}

void inArray;

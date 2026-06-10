import { Worker, type Job } from "bullmq";
import { and, eq, sql as dsql } from "drizzle-orm";
import {
  db,
  integrations,
  integrationLogs,
  metricRecords,
  usageRecords,
} from "@growengine/db";
import {
  bullConnectionOptions,
  QUEUE_NAMES,
  type IntegrationJobData,
  getConnector,
  decryptJson,
  encryptJson,
  validateIncomingMetric,
  detectAnomaly,
  summarizeFindings,
  publishEvent,
  EVENT_TYPES,
  type SanityFinding,
  type ConnectorContext,
} from "@growengine/core";
import { markJobStatus } from "../lib/track.js";

/**
 * Integration Worker — handles Meta, GA4, Google Ads, TikTok, LinkedIn, X
 * and CRM syncs. Every metric passes the Sanity Check Engine before
 * storage, and every stored fact carries its provider request id.
 */

async function buildContext(integrationId: string): Promise<{
  ctx: ConnectorContext;
  row: typeof integrations.$inferSelect;
}> {
  const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId));
  if (!row) throw new Error(`Integration ${integrationId} not found`);
  const credentials = row.encryptedCredentials
    ? decryptJson<Record<string, string>>(row.encryptedCredentials)
    : {};
  return {
    row,
    ctx: {
      tenantId: row.tenantId,
      integrationId: row.id,
      externalAccountId: row.externalAccountId ?? "",
      credentials,
      config: row.config as Record<string, unknown>,
    },
  };
}

async function handleSync(data: IntegrationJobData) {
  const { ctx, row } = await buildContext(data.integrationId);
  const connector = getConnector(row.provider);
  const startedAt = new Date();

  const [log] = await db
    .insert(integrationLogs)
    .values({
      tenantId: row.tenantId,
      integrationId: row.id,
      status: "started",
      operation: data.operation,
    })
    .returning();

  await db
    .update(integrations)
    .set({ status: "syncing", updatedAt: new Date() })
    .where(eq(integrations.id, row.id));

  try {
    const until = data.options?.until ?? new Date().toISOString().slice(0, 10);
    const since =
      data.options?.since ??
      (row.lastSuccessfulSyncAt
        ? new Date(row.lastSuccessfulSyncAt.getTime() - 2 * 86400_000).toISOString().slice(0, 10)
        : new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10));

    const { metrics, requestIds } = await connector.fetchMetrics(ctx, since, until);

    const allFindings: SanityFinding[] = [];
    let stored = 0;

    // Trailing history per metric for anomaly detection
    const historyCache = new Map<string, number[]>();
    for (const raw of metrics) {
      const { ok, data: metric, findings } = validateIncomingMetric(raw);
      allFindings.push(...findings);
      if (!ok || !metric) continue;

      let history = historyCache.get(metric.metric);
      if (!history) {
        const rows = await db
          .select({ value: metricRecords.value })
          .from(metricRecords)
          .where(
            and(
              eq(metricRecords.integrationId, row.id),
              eq(metricRecords.metric, metric.metric)
            )
          )
          .orderBy(dsql`${metricRecords.date} DESC`)
          .limit(60);
        history = rows.map((r) => Number(r.value));
        historyCache.set(metric.metric, history);
      }
      const anomaly = detectAnomaly(metric.value, history, metric.metric, metric.date);
      if (anomaly) allFindings.push(anomaly);

      const sanity = summarizeFindings(anomaly ? [anomaly] : []);
      await db
        .insert(metricRecords)
        .values({
          tenantId: row.tenantId,
          clientId: row.clientId,
          integrationId: row.id,
          provider: row.provider,
          metric: metric.metric,
          dimensions: metric.dimensions,
          date: metric.date,
          value: String(metric.value),
          currency: metric.currency,
          sourceRequestId: metric.sourceRequestId,
          sourceReferenceUrl: metric.sourceReferenceUrl,
          sanityStatus: sanity.status,
          sanityNotes: sanity.findings,
        })
        .onConflictDoUpdate({
          target: [
            metricRecords.integrationId,
            metricRecords.metric,
            metricRecords.date,
            metricRecords.dimensions,
          ],
          set: {
            value: String(metric.value),
            sourceRequestId: metric.sourceRequestId,
            sourceReferenceUrl: metric.sourceReferenceUrl,
            sanityStatus: sanity.status,
            sanityNotes: sanity.findings,
            fetchedAt: new Date(),
          },
        });
      stored++;
    }

    await db
      .update(integrationLogs)
      .set({
        status: allFindings.some((f) => f.level === "error") ? "partial" : "success",
        apiRequestIds: requestIds,
        recordsFetched: metrics.length,
        recordsStored: stored,
        sanityFindings: allFindings,
        durationMs: Date.now() - startedAt.getTime(),
        finishedAt: new Date(),
      })
      .where(eq(integrationLogs.id, log.id));

    await db
      .update(integrations)
      .set({
        status: "connected",
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        lastError: null,
        consecutiveFailures: 0,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, row.id));

    await db.insert(usageRecords).values({
      tenantId: row.tenantId,
      meter: "integration_syncs",
      quantity: "1",
      usageDate: new Date().toISOString().slice(0, 10),
      metadata: { provider: row.provider, integrationId: row.id },
    });

    await publishEvent({
      tenantId: row.tenantId,
      eventType: EVENT_TYPES.integrationSyncCompleted,
      entityType: "integration",
      entityId: row.id,
      payload: {
        provider: row.provider,
        clientId: row.clientId,
        recordsStored: stored,
        sanityWarnings: allFindings.filter((f) => f.level === "warning").length,
      },
    });
  } catch (err) {
    const message = (err as Error).message;
    await db
      .update(integrationLogs)
      .set({
        status: "failed",
        error: message,
        durationMs: Date.now() - startedAt.getTime(),
        finishedAt: new Date(),
      })
      .where(eq(integrationLogs.id, log.id));
    await db
      .update(integrations)
      .set({
        status: message.toLowerCase().includes("token") ? "token_expired" : "error",
        lastSyncAt: new Date(),
        lastError: message,
        consecutiveFailures: row.consecutiveFailures + 1,
        updatedAt: new Date(),
      })
      .where(eq(integrations.id, row.id));
    await publishEvent({
      tenantId: row.tenantId,
      eventType: EVENT_TYPES.integrationFailed,
      entityType: "integration",
      entityId: row.id,
      payload: { provider: row.provider, clientId: row.clientId, error: message },
    });
    throw err;
  }
}

async function handleRefreshToken(data: IntegrationJobData) {
  const { ctx, row } = await buildContext(data.integrationId);
  const connector = getConnector(row.provider);
  if (!connector.refreshToken) return;
  const refreshed = await connector.refreshToken(ctx);
  if (!refreshed) return;
  await db
    .update(integrations)
    .set({
      encryptedCredentials: encryptJson(refreshed.credentials),
      tokenExpiresAt: refreshed.expiresAt,
      status: "connected",
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, row.id));
}

async function handleHealthCheck(data: IntegrationJobData) {
  const { ctx, row } = await buildContext(data.integrationId);
  const connector = getConnector(row.provider);
  const result = await connector.testConnection(ctx);
  await db
    .update(integrations)
    .set({
      status: result.ok ? "connected" : "error",
      lastError: result.ok ? null : result.detail,
      updatedAt: new Date(),
    })
    .where(eq(integrations.id, row.id));
}

export function createIntegrationWorker() {
  const worker = new Worker<IntegrationJobData>(
    QUEUE_NAMES.integration,
    async (job: Job<IntegrationJobData>) => {
      await markJobStatus(job, "active");
      switch (job.data.operation) {
        case "sync":
        case "backfill":
          return handleSync(job.data);
        case "refresh_token":
          return handleRefreshToken(job.data);
        case "health_check":
          return handleHealthCheck(job.data);
      }
    },
    { connection: bullConnectionOptions(), concurrency: 4 }
  );
  worker.on("completed", (job) => markJobStatus(job, "completed"));
  worker.on("failed", (job, err) => job && markJobStatus(job, "failed", err.message));
  return worker;
}

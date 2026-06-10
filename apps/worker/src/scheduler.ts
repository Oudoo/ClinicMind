import { and, eq, lt, sql as dsql } from "drizzle-orm";
import { db, integrations, tenants, clients } from "@growengine/db";
import {
  enqueueIntegrationJob,
  enqueueAiJob,
  enqueueNotificationJob,
  publishEvent,
  EVENT_TYPES,
  redis,
} from "@growengine/core";

/**
 * Scheduler — periodic orchestration. Runs inside the worker process on
 * setInterval ticks guarded by Redis locks so multiple worker instances
 * never double-schedule.
 */

async function withLock(key: string, ttlSeconds: number, fn: () => Promise<void>) {
  const acquired = await redis.set(`scheduler:lock:${key}`, "1", "EX", ttlSeconds, "NX");
  if (!acquired) return;
  await fn();
}

/** Every 5 minutes: queue syncs for integrations whose frequency elapsed. */
async function scheduleDueSyncs() {
  const due = await db
    .select()
    .from(integrations)
    .where(
      and(
        dsql`${integrations.status} IN ('connected','error')`,
        dsql`(${integrations.lastSyncAt} IS NULL OR ${integrations.lastSyncAt} < NOW() - (${integrations.syncFrequencyMinutes} || ' minutes')::interval)`,
        dsql`${integrations.consecutiveFailures} < 10`
      )
    )
    .limit(50);

  for (const integration of due) {
    await enqueueIntegrationJob({
      tenantId: integration.tenantId,
      integrationId: integration.id,
      operation: "sync",
    });
  }
}

/** Hourly: refresh tokens expiring within 72h and warn at 7 days. */
async function scheduleTokenRefresh() {
  const expiring = await db
    .select()
    .from(integrations)
    .where(
      and(
        dsql`${integrations.tokenExpiresAt} IS NOT NULL`,
        lt(integrations.tokenExpiresAt, new Date(Date.now() + 72 * 3600_000))
      )
    );
  for (const integration of expiring) {
    await enqueueIntegrationJob({
      tenantId: integration.tenantId,
      integrationId: integration.id,
      operation: "refresh_token",
    });
    await publishEvent({
      tenantId: integration.tenantId,
      eventType: EVENT_TYPES.integrationTokenExpiring,
      entityType: "integration",
      entityId: integration.id,
      payload: {
        provider: integration.provider,
        name: integration.name,
        expiresAt: integration.tokenExpiresAt?.toISOString(),
      },
    });
  }
}

/** Daily jobs: retention enforcement, process intelligence, weekly digests on Mondays, monthly on the 1st, scorecards on the 1st. */
async function scheduleDaily() {
  const allTenants = await db.select().from(tenants).where(eq(tenants.status, "active"));
  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  const isFirstOfMonth = now.getUTCDate() === 1;

  for (const tenant of allTenants) {
    await enqueueAiJob({
      tenantId: tenant.id,
      aiJobId: "",
      jobType: "retention_enforcement",
      input: {},
    });
    await enqueueAiJob({
      tenantId: tenant.id,
      aiJobId: "",
      jobType: "process_intelligence",
      input: {},
    });

    if (isMonday) {
      await enqueueNotificationJob({ tenantId: tenant.id, kind: "digest_weekly", input: {} });
    }
    if (isFirstOfMonth) {
      await enqueueNotificationJob({ tenantId: tenant.id, kind: "digest_monthly", input: {} });
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), 1));
      await enqueueAiJob({
        tenantId: tenant.id,
        aiJobId: "",
        jobType: "scorecards",
        input: {
          periodStart: periodStart.toISOString().slice(0, 10),
          periodEnd: periodEnd.toISOString().slice(0, 10),
        },
      });
    }

    // Refresh health scores for active clients daily
    const activeClients = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.tenantId, tenant.id), eq(clients.status, "active")));
    for (const client of activeClients) {
      await enqueueAiJob({
        tenantId: tenant.id,
        aiJobId: "",
        jobType: "health_score",
        input: { clientId: client.id },
      });
    }
  }
}

export function startScheduler() {
  const fiveMin = setInterval(
    () => withLock("due_syncs", 240, scheduleDueSyncs).catch(console.error),
    5 * 60_000
  );
  const hourly = setInterval(
    () => withLock("token_refresh", 3500, scheduleTokenRefresh).catch(console.error),
    60 * 60_000
  );
  const daily = setInterval(
    () => withLock(`daily:${new Date().toISOString().slice(0, 10)}`, 86_400, scheduleDaily).catch(console.error),
    15 * 60_000
  );
  return () => {
    clearInterval(fiveMin);
    clearInterval(hourly);
    clearInterval(daily);
  };
}

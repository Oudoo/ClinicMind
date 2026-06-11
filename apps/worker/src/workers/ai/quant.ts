import { and, eq, gte, sql as dsql } from "drizzle-orm";
import {
  db,
  metricRecords,
  forecasts,
  seasonalityPatterns,
  lostOpportunities,
  healthScores,
  teamScorecards,
  tasks,
  tickets,
  users,
  clients,
} from "@growengine/db";
import {
  forecastSeries,
  extractMonthlySeasonality,
  quantifyLostOpportunity,
  coefficientOfVariation,
  computeConfidence,
  publishEvent,
  EVENT_TYPES,
  aiComplete,
  type AiJobData,
} from "@growengine/core";

/**
 * Quantitative AI jobs — deterministic math first, LLM only for the
 * narrative. Every output carries the Confidence Framework triplet
 * (score, data sources, evidence count).
 */

async function loadDailySeries(tenantId: string, clientId: string, metric: string) {
  const rows = await db
    .select({
      date: metricRecords.date,
      value: dsql<string>`SUM(${metricRecords.value})`,
      provider: dsql<string>`MIN(${metricRecords.provider}::text)`,
      sanityPassed: dsql<string>`SUM(CASE WHEN ${metricRecords.sanityStatus} = 'passed' THEN 1 ELSE 0 END)`,
      total: dsql<string>`COUNT(*)`,
      latestFetch: dsql<string>`MAX(${metricRecords.fetchedAt})`,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, tenantId),
        eq(metricRecords.clientId, clientId),
        eq(metricRecords.metric, metric)
      )
    )
    .groupBy(metricRecords.date)
    .orderBy(metricRecords.date);

  const providers = await db
    .selectDistinct({ provider: metricRecords.provider })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, tenantId),
        eq(metricRecords.clientId, clientId),
        eq(metricRecords.metric, metric)
      )
    );

  const series = rows.map((r) => ({ date: r.date, value: Number(r.value) }));
  const sanityPassed = rows.reduce((a, r) => a + Number(r.sanityPassed), 0);
  const totalRecords = rows.reduce((a, r) => a + Number(r.total), 0);
  const latestFetch = rows.length
    ? new Date(Math.max(...rows.map((r) => new Date(r.latestFetch).getTime())))
    : null;
  return {
    series,
    sources: providers.map((p) => p.provider),
    sanityPassRate: totalRecords ? sanityPassed / totalRecords : 1,
    latestFetch,
  };
}

export async function handleForecast(data: AiJobData) {
  const { clientId, metric, horizonDays, forecastId } = data.input as {
    clientId: string;
    metric: string;
    horizonDays?: number;
    forecastId: string;
  };

  await db.update(forecasts).set({ status: "running" }).where(eq(forecasts.id, forecastId));

  const { series, sources, sanityPassRate, latestFetch } = await loadDailySeries(
    data.tenantId,
    clientId,
    metric
  );
  if (series.length === 0) {
    await db
      .update(forecasts)
      .set({ status: "failed", narrative: "No historical data available for this metric." })
      .where(eq(forecasts.id, forecastId));
    return;
  }

  const horizon = horizonDays ?? 30;
  const output = forecastSeries(series, horizon);
  const confidence = computeConfidence({
    evidenceCount: series.length,
    dataWindowDays: series.length,
    dataFreshnessHours: latestFetch
      ? (Date.now() - latestFetch.getTime()) / 3600_000
      : 24 * 30,
    variability: output.variability,
    backtestMape: output.backtestMape ?? undefined,
    sanityPassRate,
    sourceCount: sources.length,
  });

  let narrative: string | null = null;
  try {
    narrative = await aiComplete(
      `You are a marketing analytics expert. Write a concise 3-4 sentence plain-language summary of this forecast for a client dashboard. Metric: ${metric}. Horizon: ${horizon} days. Recent daily average: ${(series.slice(-14).reduce((a, p) => a + p.value, 0) / Math.min(14, series.length)).toFixed(2)}. Forecast for the horizon (first/mid/last): ${JSON.stringify([output.points[0], output.points[Math.floor(output.points.length / 2)], output.points[output.points.length - 1]])}. Backtest MAPE: ${output.backtestMape ?? "n/a"}%. Confidence: ${confidence.score}%. Do not invent numbers.`,
      { tenantId: data.tenantId, clientId, feature: "forecast", aiJobId: data.aiJobId },
      { maxTokens: 400 }
    );
  } catch {
    /* narrative is optional; the math stands on its own */
  }

  await db
    .update(forecasts)
    .set({
      status: "completed",
      points: output.points,
      method: output.method,
      confidenceScore: String(confidence.score),
      dataSources: sources,
      evidenceCount: series.length,
      trainingWindow: output.trainingWindow,
      backtestMape: output.backtestMape !== null ? String(output.backtestMape) : null,
      narrative,
      completedAt: new Date(),
    })
    .where(eq(forecasts.id, forecastId));

  await publishEvent({
    tenantId: data.tenantId,
    eventType: EVENT_TYPES.forecastGenerated,
    entityType: "forecast",
    entityId: forecastId,
    payload: { clientId, metric, confidence: confidence.score },
  });
}

export async function handleSeasonality(data: AiJobData) {
  const { clientId, metric } = data.input as { clientId: string; metric: string };
  const { series, sanityPassRate, sources, latestFetch } = await loadDailySeries(
    data.tenantId,
    clientId,
    metric
  );
  if (series.length < 60) return;

  const heatmap = extractMonthlySeasonality(series);
  const confidence = computeConfidence({
    evidenceCount: series.length,
    dataWindowDays: series.length,
    dataFreshnessHours: latestFetch ? (Date.now() - latestFetch.getTime()) / 3600_000 : 720,
    variability: coefficientOfVariation(series.map((s) => s.value)),
    sanityPassRate,
    sourceCount: sources.length,
  });

  const budgetScalingMap = heatmap.map((h) => ({
    month: h.month,
    label: h.label,
    recommendedMultiplier: Math.round(Math.max(0.5, Math.min(2.5, h.index)) * 100) / 100,
  }));

  await db.insert(seasonalityPatterns).values({
    tenantId: data.tenantId,
    clientId,
    metric,
    heatmap,
    budgetScalingMap,
    yearsOfData: String(Math.round((series.length / 365) * 10) / 10),
    confidenceScore: String(confidence.score),
  });
}

export async function handleLostOpportunity(data: AiJobData) {
  const { clientId, metric } = data.input as { clientId: string; metric: string };
  const { series, sanityPassRate, sources, latestFetch } = await loadDailySeries(
    data.tenantId,
    clientId,
    metric
  );
  if (series.length < 90) return;

  const seasonality = extractMonthlySeasonality(series);
  const estimate = quantifyLostOpportunity(series, seasonality);
  if (estimate.evidenceCount === 0) return;

  const confidence = computeConfidence({
    evidenceCount: estimate.evidenceCount,
    dataWindowDays: series.length,
    dataFreshnessHours: latestFetch ? (Date.now() - latestFetch.getTime()) / 3600_000 : 720,
    variability: coefficientOfVariation(series.map((s) => s.value)),
    sanityPassRate,
    sourceCount: sources.length,
  });

  await db.insert(lostOpportunities).values({
    tenantId: data.tenantId,
    clientId,
    title: `Missed ${metric} during high-season windows`,
    periodStart: series[0].date,
    periodEnd: series[series.length - 1].date,
    metric,
    missedValueLow: String(estimate.missedLow),
    missedValueHigh: String(estimate.missedHigh),
    methodology: estimate.methodology,
    confidenceScore: String(confidence.score),
    dataSources: sources,
    evidenceCount: estimate.evidenceCount,
  });
}

export async function handleHealthScore(data: AiJobData) {
  const { clientId } = data.input as { clientId: string };
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, data.tenantId)));
  if (!client) return;

  // Performance: spend efficiency trend over the trailing 60 days
  const spend = await loadDailySeries(data.tenantId, clientId, "spend");
  const conversions = await loadDailySeries(data.tenantId, clientId, "conversions");
  const revenue = await loadDailySeries(data.tenantId, clientId, "revenue");

  const recent = (s: { date: string; value: number }[], days: number) =>
    s.slice(-days).reduce((a, p) => a + p.value, 0);

  const drivers: { name: string; detail: string; direction: "up" | "down" | "flat" }[] = [];

  let performance = 60;
  if (spend.series.length >= 28 && conversions.series.length >= 28) {
    const cpaRecent = recent(spend.series, 14) / Math.max(recent(conversions.series, 14), 1);
    const cpaPrior =
      recent(spend.series.slice(0, -14), 14) /
      Math.max(recent(conversions.series.slice(0, -14), 14), 1);
    if (cpaPrior > 0) {
      const change = (cpaRecent - cpaPrior) / cpaPrior;
      performance = Math.max(0, Math.min(100, 60 - change * 200));
      drivers.push({
        name: "CPA trend",
        detail: `CPA ${change >= 0 ? "rose" : "fell"} ${(Math.abs(change) * 100).toFixed(1)}% vs prior 14 days`,
        direction: change > 0.02 ? "down" : change < -0.02 ? "up" : "flat",
      });
    }
  }

  // Delivery: open overdue tasks + SLA breaches
  const openTasks = await db
    .select({ count: dsql<string>`COUNT(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, data.tenantId),
        eq(tasks.clientId, clientId),
        dsql`${tasks.status} NOT IN ('done','cancelled')`,
        dsql`${tasks.dueDate} < CURRENT_DATE`
      )
    );
  const overdue = Number(openTasks[0]?.count ?? 0);
  const delivery = Math.max(0, 90 - overdue * 10);
  if (overdue > 0) {
    drivers.push({ name: "Overdue tasks", detail: `${overdue} overdue task(s)`, direction: "down" });
  }

  // Engagement: tickets waiting on client / recency of data
  const openTickets = await db
    .select({ count: dsql<string>`COUNT(*)` })
    .from(tickets)
    .where(
      and(
        eq(tickets.tenantId, data.tenantId),
        eq(tickets.clientId, clientId),
        dsql`${tickets.status} IN ('open','in_progress')`
      )
    );
  const engagement = Math.max(20, 95 - Number(openTickets[0]?.count ?? 0) * 5);

  const growth =
    revenue.series.length >= 28
      ? Math.max(
          0,
          Math.min(
            100,
            60 +
              ((recent(revenue.series, 14) - recent(revenue.series.slice(0, -14), 14)) /
                Math.max(recent(revenue.series.slice(0, -14), 14), 1)) *
                200
          )
        )
      : 60;

  const score =
    Math.round((performance * 0.35 + delivery * 0.25 + engagement * 0.15 + growth * 0.25) * 100) /
    100;

  const [previous] = await db
    .select()
    .from(healthScores)
    .where(and(eq(healthScores.tenantId, data.tenantId), eq(healthScores.clientId, clientId)))
    .orderBy(dsql`${healthScores.computedAt} DESC`)
    .limit(1);

  const trend = !previous
    ? "stable"
    : score > Number(previous.score) + 2
      ? "improving"
      : score < Number(previous.score) - 2
        ? "declining"
        : "stable";

  await db.insert(healthScores).values({
    tenantId: data.tenantId,
    clientId,
    score: String(score),
    components: { performance, delivery, engagement, growth },
    trend,
    drivers,
  });

  await publishEvent({
    tenantId: data.tenantId,
    eventType: EVENT_TYPES.healthScoreComputed,
    entityType: "client",
    entityId: clientId,
    payload: { clientId, score, trend },
  });
}

export async function handleScorecards(data: AiJobData) {
  const { periodStart, periodEnd } = data.input as { periodStart: string; periodEnd: string };
  const teamUsers = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, data.tenantId), dsql`${users.clientId} IS NULL`));

  for (const user of teamUsers) {
    const userTasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, data.tenantId),
          eq(tasks.assigneeId, user.id),
          gte(tasks.updatedAt, new Date(periodStart))
        )
      );
    const completed = userTasks.filter(
      (t) => t.status === "done" && t.completedAt && t.completedAt <= new Date(`${periodEnd}T23:59:59Z`)
    );
    const onTime = completed.filter(
      (t) => !t.dueDate || (t.completedAt && t.completedAt <= new Date(`${t.dueDate}T23:59:59Z`))
    );
    const cycleTimes = completed
      .filter((t) => t.startedAt && t.completedAt)
      .map((t) => (t.completedAt!.getTime() - t.startedAt!.getTime()) / 3600_000);
    const reworked = completed.filter((t) => t.reworkCount > 0);

    const userTickets = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.tenantId, data.tenantId),
          eq(tickets.assigneeId, user.id),
          gte(tickets.updatedAt, new Date(periodStart))
        )
      );
    const resolved = userTickets.filter((t) => t.resolvedAt);
    const slaTracked = resolved.filter((t) => t.slaDueAt);
    const slaMet = slaTracked.filter((t) => t.resolvedAt! <= t.slaDueAt!);
    const firstResponses = userTickets
      .filter((t) => t.firstResponseAt)
      .map((t) => (t.firstResponseAt!.getTime() - t.createdAt.getTime()) / 60_000);

    if (completed.length === 0 && resolved.length === 0) continue;

    await db.insert(teamScorecards).values({
      tenantId: data.tenantId,
      userId: user.id,
      periodStart,
      periodEnd,
      tasksCompleted: completed.length,
      tasksOnTime: onTime.length,
      avgCycleTimeHours: cycleTimes.length
        ? (cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length).toFixed(2)
        : null,
      slaCompliancePct: slaTracked.length
        ? ((slaMet.length / slaTracked.length) * 100).toFixed(2)
        : null,
      reworkRatePct: completed.length
        ? ((reworked.length / completed.length) * 100).toFixed(2)
        : "0",
      ticketsResolved: resolved.length,
      avgFirstResponseMinutes: firstResponses.length
        ? (firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length).toFixed(2)
        : null,
    });
  }
}

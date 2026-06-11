import { and, eq, sql as dsql } from "drizzle-orm";
import {
  db,
  metricRecords,
  leadAudits,
  knowledgeDocuments,
  processInsights,
  clients,
  tickets,
  tasks,
  users,
  notifications,
} from "@growengine/db";
import {
  aiComplete,
  aiCompleteJson,
  fetchPage,
  computeConfidence,
  publishEvent,
  EVENT_TYPES,
  notify,
  type AiJobData,
} from "@growengine/core";

/**
 * Report-shaped AI jobs: lead-magnet audits, KPI digests, QBR generation
 * and the Process Intelligence Engine.
 */

export async function handleLeadAudit(data: AiJobData) {
  const { leadAuditId } = data.input as { leadAuditId: string };
  const [lead] = await db
    .select()
    .from(leadAudits)
    .where(and(eq(leadAudits.id, leadAuditId), eq(leadAudits.tenantId, data.tenantId)));
  if (!lead) throw new Error(`Lead audit ${leadAuditId} not found`);

  await db.update(leadAudits).set({ status: "processing" }).where(eq(leadAudits.id, leadAuditId));

  try {
    // Real crawl of the prospect's site — this is live data, not canned output
    const page = await fetchPage(lead.websiteUrl);
    const ctx = { tenantId: data.tenantId, feature: "lead_audit", aiJobId: data.aiJobId };

    const result = await aiCompleteJson<{
      score: number;
      findings: { area: string; severity: "low" | "medium" | "high"; finding: string; quickWin: string }[];
      reportMarkdown: string;
    }>(
      `You are a growth auditor producing a high-level automated business audit for a prospective client (lead magnet — credible, useful, and clearly leaving room for a deeper paid engagement).

COMPANY: ${lead.companyName} | INDUSTRY: ${lead.industry ?? "unknown"} | STATED GOAL: ${lead.primaryGoal ?? "unknown"} | MONTHLY AD BUDGET: ${lead.monthlyAdBudget ?? "unknown"}
QUESTIONNAIRE: ${JSON.stringify(lead.responses)}

LIVE WEBSITE CRAWL of ${lead.websiteUrl}:
- Title: ${page.title}
- Meta description: ${page.metaDescription ?? "(missing)"}
- Headings: ${JSON.stringify(page.headings.slice(0, 25))}
- JSON-LD structured data blocks found: ${page.structuredData.length}
- Word count: ${page.wordCount}
- First 3000 chars of copy: ${page.text.slice(0, 3000)}

Return strict JSON:
- "score": 0-100 overall growth-readiness score
- "findings": 5-8 items [{area, severity, finding, quickWin}] covering messaging, SEO/AEO readiness, conversion paths, trust signals, and analytics readiness — grounded in what the crawl actually shows
- "reportMarkdown": polished audit report in markdown addressed to ${lead.contactName}.`,
      ctx,
      { maxTokens: 5000 }
    );

    await db
      .update(leadAudits)
      .set({
        status: "completed",
        auditReport: result.reportMarkdown,
        auditScore: String(Math.max(0, Math.min(100, result.score))),
        auditFindings: result.findings,
        completedAt: new Date(),
      })
      .where(eq(leadAudits.id, leadAuditId));

    // Alert the team — completed lead audits are upsell triggers
    const admins = await db
      .select()
      .from(users)
      .where(and(eq(users.tenantId, data.tenantId), dsql`${users.clientId} IS NULL`))
      .limit(10);
    for (const admin of admins) {
      await notify({
        tenantId: data.tenantId,
        userId: admin.id,
        channel: "in_app",
        title: `New lead audit completed: ${lead.companyName}`,
        body: `Score ${result.score}/100 — ${lead.contactName} <${lead.contactEmail}>. Follow up while it's warm.`,
        linkUrl: `/leads/${leadAuditId}`,
      });
    }

    await publishEvent({
      tenantId: data.tenantId,
      eventType: EVENT_TYPES.leadAuditCompleted,
      entityType: "lead_audit",
      entityId: leadAuditId,
      payload: { companyName: lead.companyName, score: result.score },
    });
  } catch (err) {
    await db
      .update(leadAudits)
      .set({ status: "failed", error: (err as Error).message })
      .where(eq(leadAudits.id, leadAuditId));
    throw err;
  }
}

export async function handleDigest(data: AiJobData) {
  const { clientId, period } = data.input as { clientId: string; period: "weekly" | "monthly" };
  const days = period === "weekly" ? 7 : 30;

  const facts = await db
    .select({
      metric: metricRecords.metric,
      current: dsql<string>`SUM(CASE WHEN ${metricRecords.date} >= CURRENT_DATE - INTERVAL '${dsql.raw(String(days))} days' THEN ${metricRecords.value} ELSE 0 END)`,
      previous: dsql<string>`SUM(CASE WHEN ${metricRecords.date} < CURRENT_DATE - INTERVAL '${dsql.raw(String(days))} days' AND ${metricRecords.date} >= CURRENT_DATE - INTERVAL '${dsql.raw(String(days * 2))} days' THEN ${metricRecords.value} ELSE 0 END)`,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, data.tenantId),
        eq(metricRecords.clientId, clientId),
        dsql`${metricRecords.date} >= CURRENT_DATE - INTERVAL '${dsql.raw(String(days * 2))} days'`
      )
    )
    .groupBy(metricRecords.metric);

  if (facts.length === 0) return;

  const ctx = { tenantId: data.tenantId, clientId, feature: "digest", aiJobId: data.aiJobId };
  const markdown = await aiComplete(
    `Write a ${period} KPI digest for a client portal in markdown. Compare current period vs previous (real data): ${JSON.stringify(facts)}. Short, scannable: headline summary, a metric table with period-over-period % change, two insights, one focus for next period. Never invent numbers.`,
    ctx,
    { maxTokens: 2500 }
  );

  const [doc] = await db
    .insert(knowledgeDocuments)
    .values({
      tenantId: data.tenantId,
      clientId,
      type: "digest",
      title: `${period === "weekly" ? "Weekly" : "Monthly"} KPI Digest — ${new Date().toISOString().slice(0, 10)}`,
      contentMarkdown: markdown,
    })
    .returning();

  // Deliver to client portal users by email + in-app
  const portalUsers = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, data.tenantId), eq(users.clientId, clientId)));
  for (const u of portalUsers) {
    await notify({
      tenantId: data.tenantId,
      userId: u.id,
      channel: "in_app",
      title: doc.title,
      body: "Your latest KPI digest is ready in the portal.",
      linkUrl: `/reports/${doc.id}`,
    });
    await notify({
      tenantId: data.tenantId,
      userId: u.id,
      channel: "email",
      title: doc.title,
      body: markdown,
      metadata: { email: u.email },
    });
  }
}

export async function handleQbr(data: AiJobData) {
  const { clientId } = data.input as { clientId: string };
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, data.tenantId)));
  if (!client) return;

  const facts = await db
    .select({
      metric: metricRecords.metric,
      month: dsql<string>`TO_CHAR(${metricRecords.date}::date, 'YYYY-MM')`,
      value: dsql<string>`SUM(${metricRecords.value})`,
    })
    .from(metricRecords)
    .where(
      and(
        eq(metricRecords.tenantId, data.tenantId),
        eq(metricRecords.clientId, clientId),
        dsql`${metricRecords.date} >= CURRENT_DATE - INTERVAL '120 days'`
      )
    )
    .groupBy(metricRecords.metric, dsql`TO_CHAR(${metricRecords.date}::date, 'YYYY-MM')`);

  const ctx = { tenantId: data.tenantId, clientId, feature: "qbr", aiJobId: data.aiJobId };
  const markdown = await aiComplete(
    `Generate a Quarterly Business Review presentation document in markdown for client "${client.name}". Use slide-style sections separated by "---" headers: 1) Quarter in Numbers, 2) What Worked, 3) What Didn't, 4) Competitive Context, 5) Next Quarter Plan, 6) Investment Recommendation.
Monthly metric data (real): ${JSON.stringify(facts)}
Milestone targets: ${JSON.stringify(client.milestoneTargets)}
Ground every number in the data provided; mark any section lacking data as "Data pending".`,
    ctx,
    { maxTokens: 6000 }
  );

  await db.insert(knowledgeDocuments).values({
    tenantId: data.tenantId,
    clientId,
    type: "qbr",
    title: `QBR — ${client.name} — Q${Math.floor(new Date().getMonth() / 3) + 1} ${new Date().getFullYear()}`,
    contentMarkdown: markdown,
  });
}

/**
 * Process Intelligence Engine — finds operational bottlenecks from CRM
 * funnel facts + ticket/task flow. The non-marketing advisory layer.
 */
export async function handleProcessIntelligence(data: AiJobData) {
  const { clientId } = data.input as { clientId?: string };

  const clientRows = clientId
    ? await db
        .select()
        .from(clients)
        .where(and(eq(clients.tenantId, data.tenantId), eq(clients.id, clientId)))
    : await db.select().from(clients).where(eq(clients.tenantId, data.tenantId));

  for (const client of clientRows) {
    // Funnel: marketing volume vs CRM conversion over two 30-day windows
    const funnel = await db
      .select({
        metric: metricRecords.metric,
        current: dsql<string>`SUM(CASE WHEN ${metricRecords.date} >= CURRENT_DATE - INTERVAL '30 days' THEN ${metricRecords.value} ELSE 0 END)`,
        previous: dsql<string>`SUM(CASE WHEN ${metricRecords.date} < CURRENT_DATE - INTERVAL '30 days' AND ${metricRecords.date} >= CURRENT_DATE - INTERVAL '60 days' THEN ${metricRecords.value} ELSE 0 END)`,
      })
      .from(metricRecords)
      .where(
        and(
          eq(metricRecords.tenantId, data.tenantId),
          eq(metricRecords.clientId, client.id),
          dsql`${metricRecords.metric} IN ('leads','deals_won','deals_lost','conversions','clicks')`
        )
      )
      .groupBy(metricRecords.metric);
    if (funnel.length === 0) continue;

    // Ticket SLA + task cycle time stats
    const slaStats = await db
      .select({
        total: dsql<string>`COUNT(*) FILTER (WHERE ${tickets.slaDueAt} IS NOT NULL AND ${tickets.resolvedAt} IS NOT NULL)`,
        breached: dsql<string>`COUNT(*) FILTER (WHERE ${tickets.resolvedAt} > ${tickets.slaDueAt})`,
      })
      .from(tickets)
      .where(and(eq(tickets.tenantId, data.tenantId), eq(tickets.clientId, client.id)));

    const cycleStats = await db
      .select({
        avgHours: dsql<string>`COALESCE(AVG(EXTRACT(EPOCH FROM (${tasks.completedAt} - ${tasks.startedAt})) / 3600), 0)`,
        reworked: dsql<string>`COUNT(*) FILTER (WHERE ${tasks.reworkCount} > 0)`,
        done: dsql<string>`COUNT(*) FILTER (WHERE ${tasks.status} = 'done')`,
      })
      .from(tasks)
      .where(and(eq(tasks.tenantId, data.tenantId), eq(tasks.clientId, client.id)));

    const evidence = {
      funnel: Object.fromEntries(
        funnel.map((f) => [f.metric, { current: Number(f.current), previous: Number(f.previous) }])
      ),
      slaBreaches: Number(slaStats[0]?.breached ?? 0),
      slaTracked: Number(slaStats[0]?.total ?? 0),
      avgTaskCycleHours: Math.round(Number(cycleStats[0]?.avgHours ?? 0) * 10) / 10,
      reworkedTasks: Number(cycleStats[0]?.reworked ?? 0),
      completedTasks: Number(cycleStats[0]?.done ?? 0),
    };

    const ctx = {
      tenantId: data.tenantId,
      clientId: client.id,
      feature: "process_intelligence",
      aiJobId: data.aiJobId,
    };

    const result = await aiCompleteJson<{
      insights: {
        insightType: "bottleneck" | "cycle_time" | "rework" | "approval_delay" | "capacity" | "funnel_leak";
        title: string;
        finding: string;
        recommendedAction: string;
        severity: "low" | "medium" | "high";
      }[];
    }>(
      `You are a business transformation consultant analyzing marketing + CRM + operations data to find process problems (the classic example: lead volume up, sales conversion down → retrain sales staff / adjust SLA).

REAL OPERATIONAL EVIDENCE for client "${client.name}":
${JSON.stringify(evidence)}

Return strict JSON {"insights": [...]} with 0-4 insights, each {insightType, title, finding (cite the numbers), recommendedAction (specific and operational, not marketing fluff), severity}. Return an empty array if the data shows no genuine problem — do not fabricate issues.`,
      ctx,
      { maxTokens: 3000 }
    );

    const evidenceCount =
      funnel.length + Number(slaStats[0]?.total ?? 0) + Number(cycleStats[0]?.done ?? 0);
    const confidence = computeConfidence({
      evidenceCount,
      dataWindowDays: 60,
      dataFreshnessHours: 24,
      variability: 0.4,
      sourceCount: 2,
    });

    for (const insight of result.insights) {
      await db.insert(processInsights).values({
        tenantId: data.tenantId,
        clientId: client.id,
        insightType: insight.insightType,
        title: insight.title,
        finding: insight.finding,
        recommendedAction: insight.recommendedAction,
        evidence,
        evidenceCount,
        confidenceScore: String(confidence.score),
        dataSources: ["metric_records", "tickets", "tasks"],
        severity: insight.severity,
      });
    }
  }
}

/** Milestone watcher — fires gamified milestone events when targets are hit. */
export async function checkMilestones(tenantId: string, clientId: string) {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.tenantId, tenantId)));
  if (!client) return;
  const targets = client.milestoneTargets as {
    metric: string;
    target: number;
    label: string;
    achievedAt?: string;
  }[];
  if (!targets?.length) return;

  let changed = false;
  for (const target of targets) {
    if (target.achievedAt) continue;
    const [row] = await db
      .select({ total: dsql<string>`SUM(${metricRecords.value})` })
      .from(metricRecords)
      .where(
        and(
          eq(metricRecords.tenantId, tenantId),
          eq(metricRecords.clientId, clientId),
          eq(metricRecords.metric, target.metric),
          dsql`${metricRecords.date} >= DATE_TRUNC('month', CURRENT_DATE)`
        )
      );
    if (Number(row?.total ?? 0) >= target.target) {
      target.achievedAt = new Date().toISOString();
      changed = true;
      await publishEvent({
        tenantId,
        eventType: EVENT_TYPES.milestoneReached,
        entityType: "client",
        entityId: clientId,
        payload: { clientId, label: target.label, metric: target.metric, target: target.target },
      });
    }
  }
  if (changed) {
    await db
      .update(clients)
      .set({ milestoneTargets: targets, updatedAt: new Date() })
      .where(eq(clients.id, clientId));
  }
}

void notifications;

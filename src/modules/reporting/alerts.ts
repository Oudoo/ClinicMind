import type { AlertRule } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TENANT_ROLES } from "@/lib/auth/rbac";
import { zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { notify } from "@/modules/notifications/service";
import { ALERT_METRIC_LABELS, ALERT_METRICS, type AlertMetricValue } from "./definitions";
import { windowEndingNow } from "./period";
import { getReportForPeriod, type Report } from "./service";

/**
 * Alert rules: a threshold on a reported metric over a window of days ending
 * now, evaluated hourly (and on demand). A rule that fires notifies the roles
 * it names, at most once per 24 hours; every evaluation stores the value.
 */
export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

export const FIRE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const AlertRuleInput = z.object({
  name: zText(120).min(1, "Name the rule"),
  metric: z.enum(ALERT_METRICS),
  comparator: z.enum(["ABOVE", "BELOW"]),
  threshold: z.number().finite(),
  windowDays: z.number().int().min(1).max(365).default(7),
  notifyRoles: z.array(z.enum(TENANT_ROLES)).min(1).default(["CLINIC_OWNER"]),
  enabled: z.boolean().default(true),
});
export type AlertRuleInput = z.infer<typeof AlertRuleInput>;

export const AlertRuleUpdateInput = AlertRuleInput.partial();

export async function listAlertRules(tenantId: string, opts: { canSeeRevenue?: boolean } = {}) {
  const rules = await db.alertRule.findMany({ where: { tenantId }, orderBy: [{ enabled: "desc" }, { createdAt: "asc" }] });
  // A revenue rule's threshold and last value are revenue figures: owner only.
  return opts.canSeeRevenue === false ? rules.map((r) => (ALERT_METRIC_LABELS[r.metric as AlertMetricValue]?.finance ? { ...r, threshold: 0, lastValue: null } : r)) : rules;
}

export async function createAlertRule(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = AlertRuleInput.parse(rawInput);
  const rule = await db.alertRule.create({ data: { tenantId, ...input, createdById: actor.id ?? null } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "alert_rule.create", entity: "AlertRule", entityId: rule.id, after: snapshot(rule) });
  return rule;
}

/** Returns null when the rule is not in the tenant (404 at the route). */
export async function updateAlertRule(tenantId: string, id: string, rawInput: unknown, actor: Actor = {}) {
  const input = AlertRuleUpdateInput.parse(rawInput);
  const before = await db.alertRule.findFirst({ where: { id, tenantId } });
  if (!before) return null;
  const rule = await db.alertRule.update({ where: { id, tenantId }, data: input });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "alert_rule.update", entity: "AlertRule", entityId: id, before: snapshot(before), after: snapshot(rule) });
  return rule;
}

function snapshot(r: AlertRule) {
  return { name: r.name, metric: r.metric, comparator: r.comparator, threshold: r.threshold, windowDays: r.windowDays, notifyRoles: r.notifyRoles, enabled: r.enabled };
}

// ── Metric values ────────────────────────────────────────────────────────────

export interface MetricCache {
  reports: Map<number, Promise<Report>>;
  timeZone?: string;
}

export const newMetricCache = (): MetricCache => ({ reports: new Map() });

async function reportFor(tenantId: string, windowDays: number, now: Date, cache: MetricCache): Promise<Report> {
  let pending = cache.reports.get(windowDays);
  if (!pending) {
    pending = (async () => {
      cache.timeZone ??= await getTenantTimezone(tenantId);
      return getReportForPeriod(tenantId, windowEndingNow(windowDays, cache.timeZone, now), {}, { now, timeZone: cache.timeZone });
    })();
    cache.reports.set(windowDays, pending);
  }
  return pending;
}

const pct = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 10);

/** The current value of an alert metric over `windowDays` ending now, in the unit shown next to the rule. */
export async function metricValue(tenantId: string, metric: AlertMetricValue, windowDays: number, now: Date, cache: MetricCache = newMetricCache()): Promise<number | null> {
  switch (metric) {
    case "NO_SHOW_RATE":
      return pct((await reportFor(tenantId, windowDays, now, cache)).m6.current.rate);
    case "FIRST_RESPONSE_P50":
      return (await reportFor(tenantId, windowDays, now, cache)).m5.current.p50;
    case "FIRST_RESPONSE_P90":
      return (await reportFor(tenantId, windowDays, now, cache)).m5.current.p90;
    case "FOLLOW_UPS_OVERDUE": {
      // M12: open lead follow-ups and concierge escalations past their target.
      const [followUps, escalations] = await Promise.all([
        db.leadFollowUp.count({ where: { tenantId, doneAt: null, dueAt: { lt: now }, lead: { deletedAt: null } } }),
        db.escalation.count({ where: { tenantId, status: "OPEN", kind: { not: "LEAD_FOLLOW_UP" }, dueAt: { lt: now } } }),
      ]);
      return followUps + escalations;
    }
    case "ESCALATIONS_UNACKNOWLEDGED":
      return db.escalation.count({ where: { tenantId, status: "OPEN", createdAt: { gte: new Date(now.getTime() - windowDays * 86_400_000) } } });
    case "CHECK_IN_ANSWER_RATE": {
      const since = new Date(now.getTime() - windowDays * 86_400_000);
      const [answered, missed] = await Promise.all([
        db.conciergeTask.count({ where: { tenantId, kind: "CHECK_IN", dueAt: { gte: since, lt: now }, status: "ANSWERED" } }),
        db.conciergeTask.count({ where: { tenantId, kind: "CHECK_IN", dueAt: { gte: since, lt: now }, status: "MISSED" } }),
      ]);
      return answered + missed ? Math.round((answered / (answered + missed)) * 1000) / 10 : null;
    }
    case "CAMPAIGN_WITHOUT_PROCEDURE":
      return (await reportFor(tenantId, windowDays, now, cache)).m13.current.items.filter((c) => c.leads >= 100 && c.procedures === 0).length;
    case "REVIEWS_PENDING": {
      const latest = await db.reviewSnapshot.findFirst({ where: { tenantId }, orderBy: { weekStart: "desc" }, select: { weekStart: true } });
      return latest ? Math.floor((now.getTime() - latest.weekStart.getTime()) / (7 * 86_400_000)) : 52;
    }
    case "LOST_LEADS_PRICE_SHARE": {
      const m7 = (await reportFor(tenantId, windowDays, now, cache)).m7.current;
      const price = m7.byReason.find((r) => r.key === "PRICE")?.count ?? 0;
      return m7.lost ? Math.round((price / m7.lost) * 1000) / 10 : null;
    }
    case "LEAD_TO_CONSULTATION":
      return pct((await reportFor(tenantId, windowDays, now, cache)).m2.current.rate);
    case "REVENUE":
      return (await reportFor(tenantId, windowDays, now, cache)).m4?.current.revenue ?? null;
  }
}

export function ruleFires(rule: { comparator: string; threshold: number }, value: number | null): boolean {
  if (value === null) return false;
  return rule.comparator === "ABOVE" ? value > rule.threshold : value < rule.threshold;
}

export interface AlertEvaluation {
  id: string;
  name: string;
  metric: AlertMetricValue;
  value: number | null;
  threshold: number;
  comparator: string;
  fired: boolean;
  notified: boolean;
}

/** Evaluate every enabled rule of the tenant; fire at most once per 24 h per rule. */
export async function evaluateAlertRules(tenantId: string, now: Date = new Date()): Promise<AlertEvaluation[]> {
  const rules = await db.alertRule.findMany({ where: { tenantId, enabled: true } });
  const cache = newMetricCache();
  const results: AlertEvaluation[] = [];
  for (const rule of rules) {
    const metric = rule.metric as AlertMetricValue;
    let value: number | null = null;
    try {
      value = await metricValue(tenantId, metric, rule.windowDays, now, cache);
    } catch (err) {
      console.error(`[reporting] alert rule ${rule.id} (${metric}) failed to evaluate`, err);
      continue;
    }
    const fired = ruleFires(rule, value);
    const due = !rule.lastFiredAt || now.getTime() - rule.lastFiredAt.getTime() >= FIRE_INTERVAL_MS;
    let notified = false;
    if (fired && due) {
      const meta = ALERT_METRIC_LABELS[metric];
      const shown = value === null ? "—" : `${Number.isInteger(value) ? value : value.toFixed(1)}${meta.unit ? ` ${meta.unit}` : ""}`;
      await notify(tenantId, {
        kind: "ALERT_RULE",
        level: "WARNING",
        title: `${rule.name}: ${meta.label} is ${shown}`,
        body: `${rule.comparator === "ABOVE" ? "Above" : "Below"} the threshold of ${rule.threshold}${meta.unit ? ` ${meta.unit}` : ""} over the last ${rule.windowDays} days.`,
        href: "/dashboard/reports?tab=alerts",
        entity: "AlertRule",
        entityId: rule.id,
        roles: rule.notifyRoles,
      }).catch((err: unknown) => console.error("[reporting] alert notification failed", err));
      notified = true;
    }
    await db.alertRule.update({
      where: { id: rule.id },
      data: { lastValue: value, lastEvaluatedAt: now, ...(notified ? { lastFiredAt: now } : {}) },
    });
    results.push({ id: rule.id, name: rule.name, metric, value, threshold: rule.threshold, comparator: rule.comparator, fired, notified });
  }
  return results;
}

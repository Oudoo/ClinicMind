import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { zDate, zText } from "@/lib/validation";
import { METRIC_DEFINITIONS, METRIC_IDS, type MetricId, type MetricUnit } from "./definitions";
import type { Report } from "./service";

/**
 * Metric targets: the spec's success-metrics table (baseline, target, unit,
 * due date per metric), kept next to the current value of each metric.
 */
export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

const blankToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

export const TargetInput = z.object({
  metric: z.enum(METRIC_IDS),
  baseline: z.preprocess(blankToNull, z.number().finite().nullable()),
  target: z.preprocess(blankToNull, z.number().finite().nullable()),
  unit: z.preprocess(blankToNull, zText(20).nullable()),
  dueAt: z.preprocess(blankToNull, zDate.nullable()),
});
export type TargetInput = z.infer<typeof TargetInput>;

export const DEFAULT_UNITS: Record<MetricUnit, string> = { count: "", percent: "%", egp: "EGP", seconds: "s", score: "/5" };

export async function listTargets(tenantId: string) {
  return db.metricTarget.findMany({ where: { tenantId }, orderBy: { metric: "asc" } });
}

export async function upsertTarget(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = TargetInput.parse(rawInput);
  const before = await db.metricTarget.findUnique({ where: { tenantId_metric: { tenantId, metric: input.metric } } });
  const data = { baseline: input.baseline, target: input.target, unit: input.unit, dueAt: input.dueAt, updatedById: actor.id ?? null };
  const row = await db.metricTarget.upsert({
    where: { tenantId_metric: { tenantId, metric: input.metric } },
    create: { tenantId, metric: input.metric, ...data },
    update: data,
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "metric_target.upsert",
    entity: "MetricTarget",
    entityId: row.id,
    before: before ? { baseline: before.baseline, target: before.target, unit: before.unit, dueAt: before.dueAt?.toISOString() ?? null } : null,
    after: { metric: row.metric, baseline: row.baseline, target: row.target, unit: row.unit, dueAt: row.dueAt?.toISOString() ?? null },
  });
  return row;
}

const pct = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : Math.round(v * 1000) / 10);

/** The headline value of each metric in the report, in the metric's unit (percentages as 0–100). */
export function headlineValues(report: Report): Record<MetricId, number | null> {
  const m13 = report.m13.current;
  const withProcedures = m13.items.filter((i) => i.procedures > 0);
  return {
    M1: report.m1.current.leads,
    M2: pct(report.m2.current.rate),
    M3: pct(report.m3.current.rate),
    M4: report.m4 ? report.m4.current.revenue : null,
    M5: report.m5.current.p50,
    M6: pct(report.m6.current.rate),
    M7: report.m7.current.lost,
    M8: pct(report.m8.current.items[0]?.aiShare ?? null),
    M9: report.m9.current.leads,
    M10: pct(report.m10.current.rate),
    M11: report.m11.current.overall.avg === null ? null : Math.round(report.m11.current.overall.avg * 100) / 100,
    M12: report.m12.followUps + report.m12.escalations,
    M13: report.redacted || !withProcedures.length ? null : Math.round(m13.totals.cost / Math.max(1, m13.totals.procedures)),
  };
}

export interface TargetView {
  metric: MetricId;
  name: string;
  unit: string;
  baseline: number | null;
  target: number | null;
  current: number | null;
  dueAt: Date | null;
  goodWhen: "up" | "down";
  /** null when there is no target or no current value. */
  onTrack: boolean | null;
  finance: boolean;
}

/**
 * One row per metric: the stored baseline and target next to the current
 * value in `report`. A revenue metric's figures are blanked for a viewer
 * without finance:read (the report is redacted then).
 */
export function targetRows(targets: { metric: string; baseline: number | null; target: number | null; unit: string | null; dueAt: Date | null }[], report: Report): TargetView[] {
  const byMetric = new Map(targets.map((t) => [t.metric, t]));
  const values = headlineValues(report);
  return METRIC_DEFINITIONS.map((d) => {
    const hidden = report.redacted && Boolean(d.finance);
    const row = hidden ? undefined : byMetric.get(d.id);
    const current = hidden ? null : values[d.id];
    const target = row?.target ?? null;
    const onTrack = current === null || target === null ? null : d.goodWhen === "up" ? current >= target : current <= target;
    return {
      metric: d.id,
      name: d.name,
      unit: row?.unit ?? DEFAULT_UNITS[d.unit],
      baseline: row?.baseline ?? null,
      target,
      current,
      dueAt: row?.dueAt ?? null,
      goodWhen: d.goodWhen,
      onTrack,
      finance: Boolean(d.finance),
    };
  });
}

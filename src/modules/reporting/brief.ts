import { addDays, dateKeyInTz, startOfWeekInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { readTenantSetting, updateTenantSettings } from "@/lib/tenant-settings";
import { getTenantTimezone } from "@/modules/appointments/service";
import { notify } from "@/modules/notifications/service";
import { METRIC_BY_ID, type MetricId, type MetricUnit } from "./definitions";
import { resolvePeriod } from "./period";
import { getReportForPeriod, type Report } from "./service";

/**
 * The weekly brief: once a week, on Sunday at 08:00 clinic time, the five
 * largest changes of the week against the week before, each with a one-line
 * driver, go to the clinic owner as a WEEKLY_BRIEF notification. Idempotent
 * per week (the sent week is remembered in the tenant's "reporting" setting);
 * the Overview tab shows the same brief at any time.
 */
export const BRIEF_HOUR = 8;
const SETTINGS_KEY = "reporting";

export interface BriefLine {
  metric: MetricId;
  label: string;
  unit: MetricUnit;
  current: number | null;
  previous: number | null;
  /** Relative change, −1..∞ (null when the previous value is zero or missing). */
  change: number | null;
  good: boolean | null;
  driver: string;
  finance: boolean;
}

export interface WeeklyBrief {
  weekKey: string;
  period: { fromKey: string; toKey: string };
  previous: { fromKey: string; toKey: string };
  generatedAt: Date;
  lines: BriefLine[];
  text: string;
}

interface ReportingSettings {
  briefSentWeek?: string;
  briefSentAt?: string;
}

const fmt = (v: number | null, unit: MetricUnit): string => {
  if (v === null) return "—";
  switch (unit) {
    case "percent":
      return `${Math.round(v * 1000) / 10}%`;
    case "egp":
      return `${Math.round(v).toLocaleString("en-US")} EGP`;
    case "seconds":
      return `${Math.round(v)} s`;
    case "score":
      return `${Math.round(v * 100) / 100}/5`;
    default:
      return Math.round(v).toLocaleString("en-US");
  }
};

/** The candidate lines (one per metric with a comparison), ranked by the size of the change. */
export function pickBriefLines(report: Report, limit = 5): BriefLine[] {
  const candidates: Omit<BriefLine, "change" | "good">[] = [];
  const m1 = report.m1;
  candidates.push({
    metric: "M1",
    label: "New enquiries",
    unit: "count",
    current: m1.current.leads,
    previous: m1.previous.leads,
    driver: m1.current.items[0] ? `${m1.current.items[0].label} led with ${m1.current.items[0].count} enquiries` : "No enquiries this week",
    finance: false,
  });
  const m2 = report.m2;
  const bestSource = [...m2.current.bySource].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
  candidates.push({
    metric: "M2",
    label: "Lead to consultation",
    unit: "percent",
    current: m2.current.rate,
    previous: m2.previous.rate,
    driver: bestSource ? `${bestSource.label} converted best (${fmt(bestSource.rate, "percent")} of ${bestSource.total})` : "No leads this week",
    finance: false,
  });
  const m3 = report.m3;
  const topDoc = [...m3.current.byDoctor].sort((a, b) => b.converted - a.converted)[0];
  candidates.push({
    metric: "M3",
    label: "Consultation to procedure",
    unit: "percent",
    current: m3.current.rate,
    previous: m3.previous.rate,
    driver: topDoc ? `${topDoc.label}: ${topDoc.converted} of ${topDoc.total} consultations led to a procedure` : "No consultations this week",
    finance: false,
  });
  if (report.m4) {
    const m4 = report.m4;
    const prevByDoctor = new Map(m4.previous.byDoctor.map((d) => [d.key, d.revenue]));
    const mover = [...m4.current.byDoctor].sort((a, b) => Math.abs(b.revenue - (prevByDoctor.get(b.key) ?? 0)) - Math.abs(a.revenue - (prevByDoctor.get(a.key) ?? 0)))[0];
    candidates.push({
      metric: "M4",
      label: "Revenue",
      unit: "egp",
      current: m4.current.revenue,
      previous: m4.previous.revenue,
      driver: mover ? `${mover.label} moved most (${fmt(mover.revenue - (prevByDoctor.get(mover.key) ?? 0), "egp")} against last week)` : "No signed procedures this week",
      finance: true,
    });
  }
  const m5 = report.m5;
  candidates.push({
    metric: "M5",
    label: "First response (median)",
    unit: "seconds",
    current: m5.current.p50,
    previous: m5.previous.p50,
    driver: `AI ${fmt(m5.current.ai.p50, "seconds")} (${m5.current.ai.n}) · human ${fmt(m5.current.human.p50, "seconds")} (${m5.current.human.n})`,
    finance: false,
  });
  const m6 = report.m6;
  const worst = [...m6.current.byDoctor].filter((d) => d.total >= 3).sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0))[0];
  candidates.push({
    metric: "M6",
    label: "No-show rate",
    unit: "percent",
    current: m6.current.rate,
    previous: m6.previous.rate,
    driver: worst ? `${worst.label} had the highest rate (${fmt(worst.rate, "percent")} of ${worst.total})` : `${m6.current.noShows} of ${m6.current.booked} booked`,
    finance: false,
  });
  const m7 = report.m7;
  const topReason = [...m7.current.byReason].sort((a, b) => b.count - a.count)[0];
  candidates.push({
    metric: "M7",
    label: "Lost leads",
    unit: "count",
    current: m7.current.lost,
    previous: m7.previous.lost,
    driver: topReason && topReason.count ? `Most common reason: ${topReason.label.toLowerCase()} (${topReason.count})` : "No leads lost this week",
    finance: false,
  });
  const m9 = report.m9;
  candidates.push({
    metric: "M9",
    label: "Hair-transplant enquiries",
    unit: "count",
    current: m9.current.leads,
    previous: m9.previous.leads,
    driver: m9.current.bySource[0] ? `Top source: ${m9.current.bySource[0].label} (${m9.current.bySource[0].count})` : "None this week",
    finance: false,
  });
  const m11 = report.m11;
  candidates.push({
    metric: "M11",
    label: "Satisfaction",
    unit: "score",
    current: m11.current.overall.avg,
    previous: m11.previous.overall.avg,
    driver: `${m11.current.overall.n} check-ins answered${m11.reviews.latest ? ` · ${m11.reviews.latest.count} public reviews at ${m11.reviews.latest.rating.toFixed(1)}` : ""}`,
    finance: false,
  });
  const m13 = report.m13;
  const topCampaign = [...m13.current.items].sort((a, b) => b.procedures - a.procedures)[0];
  candidates.push({
    metric: "M13",
    label: "Procedures from campaigns",
    unit: "count",
    current: m13.current.totals.procedures,
    previous: m13.previous.totals.procedures,
    driver: topCampaign
      ? `${topCampaign.label}: ${topCampaign.procedures} procedures${!report.redacted && topCampaign.costPerProcedure !== null ? ` at ${fmt(topCampaign.costPerProcedure, "egp")} each` : ""}`
      : "No campaign leads this week",
    finance: false,
  });

  const lines: BriefLine[] = candidates.map((c) => {
    const def = METRIC_BY_ID[c.metric];
    let change: number | null = null;
    if (c.current !== null && c.previous !== null && c.previous !== 0) change = (c.current - c.previous) / Math.abs(c.previous);
    else if (c.current !== null && c.previous === 0 && c.current !== 0) change = 1;
    const good = change === null || Math.abs(change) < 0.005 ? null : def.goodWhen === "up" ? change > 0 : change < 0;
    return { ...c, change, good };
  });
  const magnitude = (l: BriefLine) => (l.change === null ? -1 : Math.abs(l.change));
  const withChange = lines.filter((l) => l.change !== null && l.current !== null).sort((a, b) => magnitude(b) - magnitude(a));
  const rest = lines.filter((l) => !withChange.includes(l) && l.current !== null);
  return [...withChange, ...rest].slice(0, limit);
}

export function briefText(brief: WeeklyBrief): string {
  const header = `Week ${brief.period.fromKey} → ${brief.period.toKey} against ${brief.previous.fromKey} → ${brief.previous.toKey}.`;
  const lines = brief.lines.map((l, i) => {
    const change = l.change === null ? "" : ` (${l.change >= 0 ? "+" : "−"}${Math.round(Math.abs(l.change) * 100)}%)`;
    return `${i + 1}. ${l.label}: ${fmt(l.current, l.unit)}${change}, was ${fmt(l.previous, l.unit)} — ${l.driver}.`;
  });
  return [header, ...lines].join("\n");
}

/** The most recent Sunday (clinic clock) as the week key, and whether the brief for it is due. */
export function briefWeek(now: Date, timeZone: string): { weekKey: string; dueAt: Date; due: boolean; from: Date; to: Date } {
  const sunday = startOfWeekInTz(now, timeZone, 0);
  const p = zonedParts(sunday, timeZone);
  const dueAt = zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: BRIEF_HOUR }, timeZone);
  return { weekKey: dateKeyInTz(sunday, timeZone), dueAt, due: now.getTime() >= dueAt.getTime(), from: addDays(sunday, -7, timeZone), to: sunday };
}

export async function buildWeeklyBrief(tenantId: string, now: Date = new Date(), opts: { canSeeRevenue?: boolean } = {}): Promise<WeeklyBrief> {
  const timeZone = await getTenantTimezone(tenantId);
  const week = briefWeek(now, timeZone);
  const period = resolvePeriod({ period: "custom", from: dateKeyInTz(week.from, timeZone), to: dateKeyInTz(addDays(week.to, -1, timeZone), timeZone) }, timeZone, now);
  const report = await getReportForPeriod(tenantId, period, {}, { now, timeZone, canSeeRevenue: opts.canSeeRevenue });
  const lines = pickBriefLines(report);
  const brief: WeeklyBrief = {
    weekKey: week.weekKey,
    period: { fromKey: period.fromKey, toKey: period.toKey },
    previous: { fromKey: report.previous.fromKey, toKey: report.previous.toKey },
    generatedAt: now,
    lines,
    text: "",
  };
  brief.text = briefText(brief);
  return brief;
}

export async function getBriefState(tenantId: string): Promise<{ sentWeek: string | null; sentAt: string | null }> {
  const s = await readTenantSetting<ReportingSettings>(tenantId, SETTINGS_KEY, {});
  return { sentWeek: s.briefSentWeek ?? null, sentAt: s.briefSentAt ?? null };
}

/** Send this week's brief to the clinic owner once it is due and not yet sent. */
export async function sendWeeklyBrief(tenantId: string, now: Date = new Date(), opts: { force?: boolean } = {}): Promise<"sent" | "already_sent" | "not_due"> {
  const timeZone = await getTenantTimezone(tenantId);
  const week = briefWeek(now, timeZone);
  if (!week.due && !opts.force) return "not_due";
  const state = await getBriefState(tenantId);
  if (state.sentWeek === week.weekKey && !opts.force) return "already_sent";
  const brief = await buildWeeklyBrief(tenantId, now);
  await notify(tenantId, {
    kind: "WEEKLY_BRIEF",
    title: `Weekly brief: ${brief.lines[0] ? `${brief.lines[0].label} ${brief.lines[0].change !== null && brief.lines[0].change >= 0 ? "up" : "down"}` : "the week in numbers"}`,
    body: brief.text,
    href: "/dashboard/reports",
    entity: "WeeklyBrief",
    entityId: brief.weekKey,
    roles: ["CLINIC_OWNER"],
  });
  const current = await readTenantSetting<ReportingSettings>(tenantId, SETTINGS_KEY, {});
  await updateTenantSettings(tenantId, { [SETTINGS_KEY]: { ...current, briefSentWeek: week.weekKey, briefSentAt: now.toISOString() } });
  return "sent";
}

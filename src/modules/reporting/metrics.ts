import { dateKeyInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import {
  APPOINTMENT_KIND_LABELS,
  CHANNEL_LABELS,
  LEAD_STAGE_LABELS,
  LEAD_STAGES,
  LOST_REASON_LABELS,
  LOST_REASONS,
  OBJECTION_LABELS,
  OBJECTION_TAGS,
} from "./definitions";
import type { Period } from "./period";

/**
 * The thirteen metrics as pure functions over fetched rows. Nothing here
 * touches the database: the service fetches rows for a period (and its
 * comparison period) and calls these, and the unit tests feed synthetic rows.
 * Every rate is `null` when its denominator is zero.
 */

const DAY_MS = 86_400_000;

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface LeadRow {
  id: string;
  createdAt: Date;
  source: string;
  campaignId: string | null;
  interests: string[];
  patientId: string | null;
  consultationAppointmentId: string | null;
  stage: string;
  lostReason: string | null;
  lostAtStage: string | null;
  lostAt: Date | null;
  wonAt: Date | null;
  objections: string[];
}

export interface AppointmentRow {
  id: string;
  patientId: string;
  doctorId: string | null;
  kind: string;
  status: string;
  startsAt: Date;
  leadId: string | null;
  patientSource: string | null;
}

export interface ProcedureRow {
  id: string;
  patientId: string;
  doctorId: string | null;
  treatmentKey: string;
  performedAt: Date;
  price: number;
  discount: number;
}

export interface PaymentRow {
  id: string;
  patientId: string;
  kind: string;
  method: string;
  amount: number;
  paidAt: Date;
  procedureId: string | null;
  appointmentId: string | null;
}

export interface MessageRow {
  conversationId: string;
  direction: string;
  author: string;
  createdAt: Date;
  channel: string;
}

export interface ConversationRow {
  id: string;
  createdAt: Date;
  objections: string[];
}

export interface CheckInRow {
  satisfaction: number | null;
  submittedAt: Date;
  /** Days between the enrolment start (the procedure) and the check-in's due time. */
  offsetDays: number;
  treatmentKey: string;
}

export interface ReviewRow {
  weekStart: Date;
  count: number;
  rating: number;
  source: string;
}

export interface OverdueRow {
  kind: "follow_up" | "escalation";
  id: string;
  ownerId: string | null;
  dueAt: Date;
  subject: string;
  href: string | null;
}

export interface CampaignRow {
  id: string;
  name: string;
  platform: string;
  treatmentKey: string | null;
}

export interface CampaignCostRow {
  campaignId: string;
  /** Calendar dates (UTC midnight), inclusive. */
  periodStart: Date;
  periodEnd: Date;
  amount: number;
}

export interface Labels {
  doctors: Map<string, string>;
  treatments: Map<string, string>;
  campaigns: Map<string, string>;
}

export const emptyLabels = (): Labels => ({ doctors: new Map(), treatments: new Map(), campaigns: new Map() });

// ── Shared shapes & helpers ──────────────────────────────────────────────────

export interface CountItem {
  key: string;
  label: string;
  count: number;
}

export interface RateItem {
  key: string;
  label: string;
  total: number;
  converted: number;
  rate: number | null;
}

export const inPeriod = (d: Date, p: Period): boolean => d.getTime() >= p.from.getTime() && d.getTime() < p.to.getTime();

export const rate = (numerator: number, denominator: number): number | null => (denominator > 0 ? numerator / denominator : null);

/** Nearest-rank percentile of an unsorted sample (p in 0..100); null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export const median = (values: readonly number[]): number | null => percentile(values, 50);

export function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

const byCountDesc = (a: { count: number }, b: { count: number }) => b.count - a.count;

function labelOf(map: Map<string, string>, key: string | null, fallback: string): string {
  return key ? (map.get(key) ?? fallback) : fallback;
}

class RateBuckets {
  private readonly map = new Map<string, RateItem>();
  add(key: string, label: string, converted: boolean): void {
    const item = this.map.get(key) ?? { key, label, total: 0, converted: 0, rate: null };
    item.total += 1;
    if (converted) item.converted += 1;
    item.rate = rate(item.converted, item.total);
    this.map.set(key, item);
  }
  list(order?: readonly string[]): RateItem[] {
    const items = [...this.map.values()];
    if (order) return items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return items.sort((a, b) => b.total - a.total);
  }
}

// ── M1 Enquiries by treatment ────────────────────────────────────────────────

export interface Enquiries {
  leads: number;
  multiInterest: number;
  items: CountItem[];
}

export function enquiriesByTreatment(leads: readonly LeadRow[], period: Period, labels: Labels, treatmentKey?: string): Enquiries {
  const counts = new Map<string, number>();
  let total = 0;
  let multi = 0;
  for (const lead of leads) {
    if (!inPeriod(lead.createdAt, period)) continue;
    const interests = [...new Set(lead.interests)];
    if (treatmentKey && !interests.includes(treatmentKey)) continue;
    total += 1;
    if (interests.length > 1) multi += 1;
    const keys = interests.length ? interests : ["unspecified"];
    for (const key of keys) {
      if (treatmentKey && key !== treatmentKey) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return {
    leads: total,
    multiInterest: multi,
    items: [...counts.entries()]
      .map(([key, count]) => ({ key, label: key === "unspecified" ? "Not specified" : labelOf(labels.treatments, key, key), count }))
      .sort(byCountDesc),
  };
}

// ── M2 Lead → consultation ───────────────────────────────────────────────────

export interface LeadConversion {
  leads: number;
  converted: number;
  rate: number | null;
  bySource: RateItem[];
  /** Lead id → the instant of the consultation that converted it (used by M13). */
  consultationAt: Map<string, Date>;
}

export const LEAD_WINDOW_DAYS = 30;

export function leadToConsultation(
  leads: readonly LeadRow[],
  appointments: readonly AppointmentRow[],
  period: Period,
  sourceLabels: Record<string, string> = {},
  windowDays = LEAD_WINDOW_DAYS,
): LeadConversion {
  const byId = new Map(appointments.map((a) => [a.id, a]));
  const consultationsByPatient = new Map<string, AppointmentRow[]>();
  for (const a of appointments) {
    if (a.kind !== "CONSULTATION" || a.status !== "COMPLETED") continue;
    const list = consultationsByPatient.get(a.patientId) ?? [];
    list.push(a);
    consultationsByPatient.set(a.patientId, list);
  }
  const buckets = new RateBuckets();
  const consultationAt = new Map<string, Date>();
  let total = 0;
  for (const lead of leads) {
    if (!inPeriod(lead.createdAt, period)) continue;
    total += 1;
    const earliest = lead.createdAt.getTime() - DAY_MS;
    const latest = lead.createdAt.getTime() + windowDays * DAY_MS;
    const within = (a: AppointmentRow) => a.startsAt.getTime() >= earliest && a.startsAt.getTime() <= latest;
    let hit: Date | null = null;
    const booked = lead.consultationAppointmentId ? byId.get(lead.consultationAppointmentId) : undefined;
    if (booked && booked.status === "COMPLETED" && within(booked)) hit = booked.startsAt;
    if (!hit && lead.patientId) {
      const candidates = (consultationsByPatient.get(lead.patientId) ?? []).filter(within).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      if (candidates[0]) hit = candidates[0].startsAt;
    }
    if (hit) consultationAt.set(lead.id, hit);
    buckets.add(lead.source, sourceLabels[lead.source] ?? lead.source, hit !== null);
  }
  return { leads: total, converted: consultationAt.size, rate: rate(consultationAt.size, total), bySource: buckets.list(), consultationAt };
}

// ── M3 Consultation → procedure ──────────────────────────────────────────────

export interface ConsultationConversion {
  consultations: number;
  converted: number;
  rate: number | null;
  byDoctor: RateItem[];
  byTreatment: CountItem[];
}

export const PROCEDURE_WINDOW_DAYS = 60;

/** The first signed procedure of the patient within `windowDays` after `at`, or null. */
function procedureAfter(procedures: readonly ProcedureRow[], patientId: string, at: Date, windowDays: number, treatmentKey?: string): ProcedureRow | null {
  const latest = at.getTime() + windowDays * DAY_MS;
  let best: ProcedureRow | null = null;
  for (const p of procedures) {
    if (p.patientId !== patientId) continue;
    if (treatmentKey && p.treatmentKey !== treatmentKey) continue;
    const t = p.performedAt.getTime();
    if (t < at.getTime() - DAY_MS || t > latest) continue;
    if (!best || t < best.performedAt.getTime()) best = p;
  }
  return best;
}

export function consultationToProcedure(
  appointments: readonly AppointmentRow[],
  procedures: readonly ProcedureRow[],
  period: Period,
  labels: Labels,
  filters: { doctorId?: string; treatmentKey?: string } = {},
  windowDays = PROCEDURE_WINDOW_DAYS,
): ConsultationConversion {
  const byDoctor = new RateBuckets();
  const byTreatment = new Map<string, number>();
  let total = 0;
  let converted = 0;
  for (const a of appointments) {
    if (a.kind !== "CONSULTATION" || a.status !== "COMPLETED" || !inPeriod(a.startsAt, period)) continue;
    if (filters.doctorId && a.doctorId !== filters.doctorId) continue;
    total += 1;
    const hit = procedureAfter(procedures, a.patientId, a.startsAt, windowDays, filters.treatmentKey);
    if (hit) {
      converted += 1;
      byTreatment.set(hit.treatmentKey, (byTreatment.get(hit.treatmentKey) ?? 0) + 1);
    }
    byDoctor.add(a.doctorId ?? "none", labelOf(labels.doctors, a.doctorId, "No doctor"), hit !== null);
  }
  return {
    consultations: total,
    converted,
    rate: rate(converted, total),
    byDoctor: byDoctor.list(),
    byTreatment: [...byTreatment.entries()].map(([key, count]) => ({ key, label: labelOf(labels.treatments, key, key), count })).sort(byCountDesc),
  };
}

// ── M4 Revenue ───────────────────────────────────────────────────────────────

export interface RevenueLine {
  key: string;
  label: string;
  revenue: number;
  procedures: number;
}

export interface Revenue {
  revenue: number;
  procedures: number;
  deposits: number;
  refunds: number;
  consultationFees: number;
  byDoctor: (RevenueLine & { byTreatment: RevenueLine[] })[];
  byTreatment: RevenueLine[];
}

export function revenueBreakdown(
  procedures: readonly ProcedureRow[],
  payments: readonly PaymentRow[],
  period: Period,
  labels: Labels,
  filters: { doctorId?: string; treatmentKey?: string } = {},
): Revenue {
  const doctors = new Map<string, RevenueLine & { byTreatment: Map<string, RevenueLine> }>();
  const treatments = new Map<string, RevenueLine>();
  let revenue = 0;
  let count = 0;
  for (const p of procedures) {
    if (!inPeriod(p.performedAt, period)) continue;
    if (filters.doctorId && p.doctorId !== filters.doctorId) continue;
    if (filters.treatmentKey && p.treatmentKey !== filters.treatmentKey) continue;
    const net = p.price - p.discount;
    revenue += net;
    count += 1;
    const dKey = p.doctorId ?? "none";
    const d = doctors.get(dKey) ?? { key: dKey, label: labelOf(labels.doctors, p.doctorId, "No doctor"), revenue: 0, procedures: 0, byTreatment: new Map() };
    d.revenue += net;
    d.procedures += 1;
    const dt = d.byTreatment.get(p.treatmentKey) ?? { key: p.treatmentKey, label: labelOf(labels.treatments, p.treatmentKey, p.treatmentKey), revenue: 0, procedures: 0 };
    dt.revenue += net;
    dt.procedures += 1;
    d.byTreatment.set(p.treatmentKey, dt);
    doctors.set(dKey, d);
    const t = treatments.get(p.treatmentKey) ?? { key: p.treatmentKey, label: labelOf(labels.treatments, p.treatmentKey, p.treatmentKey), revenue: 0, procedures: 0 };
    t.revenue += net;
    t.procedures += 1;
    treatments.set(p.treatmentKey, t);
  }
  let deposits = 0;
  let refunds = 0;
  let consultationFees = 0;
  for (const pay of payments) {
    if (!inPeriod(pay.paidAt, period)) continue;
    if (pay.kind === "DEPOSIT") deposits += pay.amount;
    else if (pay.kind === "REFUND") refunds += pay.amount;
    else if (pay.kind === "CONSULTATION_FEE") consultationFees += pay.amount;
  }
  const byRevenue = (a: RevenueLine, b: RevenueLine) => b.revenue - a.revenue;
  return {
    revenue,
    procedures: count,
    deposits,
    refunds,
    consultationFees,
    byDoctor: [...doctors.values()]
      .map((d) => ({ key: d.key, label: d.label, revenue: d.revenue, procedures: d.procedures, byTreatment: [...d.byTreatment.values()].sort(byRevenue) }))
      .sort(byRevenue),
    byTreatment: [...treatments.values()].sort(byRevenue),
  };
}

// ── M5 First-response time ───────────────────────────────────────────────────

export interface ResponseStats {
  n: number;
  p50: number | null;
  p90: number | null;
}

export interface FirstResponse extends ResponseStats {
  ai: ResponseStats;
  human: ResponseStats;
  byChannel: (ResponseStats & { channel: string; label: string })[];
  byHour: (ResponseStats & { hour: number })[];
  /** Inbound messages in the period with no reply yet. */
  unanswered: number;
}

const stats = (values: number[]): ResponseStats => ({ n: values.length, p50: percentile(values, 50), p90: percentile(values, 90) });

export function firstResponseTimes(messages: readonly MessageRow[], period: Period, timeZone: string): FirstResponse {
  const byConversation = new Map<string, MessageRow[]>();
  for (const m of messages) {
    const list = byConversation.get(m.conversationId) ?? [];
    list.push(m);
    byConversation.set(m.conversationId, list);
  }
  const samples: { seconds: number; who: "ai" | "human"; channel: string; hour: number }[] = [];
  let unanswered = 0;
  for (const list of byConversation.values()) {
    list.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 0; i < list.length; i++) {
      const m = list[i]!;
      if (m.direction !== "INBOUND" || !inPeriod(m.createdAt, period)) continue;
      const reply = list.slice(i + 1).find((x) => x.direction === "OUTBOUND");
      if (!reply) {
        unanswered += 1;
        continue;
      }
      samples.push({
        seconds: Math.max(0, Math.round((reply.createdAt.getTime() - m.createdAt.getTime()) / 1000)),
        who: reply.author === "HUMAN" ? "human" : "ai",
        channel: m.channel,
        hour: zonedParts(m.createdAt, timeZone).hour,
      });
    }
  }
  const all = samples.map((s) => s.seconds);
  const channels = [...new Set(samples.map((s) => s.channel))];
  return {
    ...stats(all),
    ai: stats(samples.filter((s) => s.who === "ai").map((s) => s.seconds)),
    human: stats(samples.filter((s) => s.who === "human").map((s) => s.seconds)),
    byChannel: channels
      .map((channel) => ({ channel, label: CHANNEL_LABELS[channel] ?? channel, ...stats(samples.filter((s) => s.channel === channel).map((s) => s.seconds)) }))
      .sort((a, b) => b.n - a.n),
    byHour: Array.from({ length: 24 }, (_, hour) => ({ hour, ...stats(samples.filter((s) => s.hour === hour).map((s) => s.seconds)) })),
    unanswered,
  };
}

// ── M6 No-show rate ──────────────────────────────────────────────────────────

export interface NoShow {
  booked: number;
  noShows: number;
  rate: number | null;
  byDoctor: RateItem[];
  byKind: RateItem[];
  byWeekday: RateItem[];
  bySource: RateItem[];
  byDeposit: RateItem[];
}

const HELD = new Set(["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW"]);
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Saturday first: the Egyptian work week. */
const WEEKDAY_ORDER = ["6", "0", "1", "2", "3", "4", "5"];

export function noShowBreakdown(
  appointments: readonly AppointmentRow[],
  period: Period,
  now: Date,
  deposits: readonly PaymentRow[],
  options: {
    leadSources?: Map<string, string>;
    /** Every held appointment of the patients involved (for the "after the previous one" rule); defaults to `appointments`. */
    priorAppointments?: readonly { patientId: string; startsAt: Date }[];
    labels?: Labels;
    sourceLabels?: Record<string, string>;
    timeZone?: string;
    doctorId?: string;
    source?: string;
  } = {},
): NoShow {
  const timeZone = options.timeZone ?? "UTC";
  const labels = options.labels ?? emptyLabels();
  const prior = options.priorAppointments ?? appointments;
  const priorByPatient = new Map<string, number[]>();
  for (const a of prior) {
    const list = priorByPatient.get(a.patientId) ?? [];
    list.push(a.startsAt.getTime());
    priorByPatient.set(a.patientId, list);
  }
  const depositsByPatient = new Map<string, PaymentRow[]>();
  for (const d of deposits) {
    if (d.kind !== "DEPOSIT") continue;
    const list = depositsByPatient.get(d.patientId) ?? [];
    list.push(d);
    depositsByPatient.set(d.patientId, list);
  }
  const byDoctor = new RateBuckets();
  const byKind = new RateBuckets();
  const byWeekday = new RateBuckets();
  const bySource = new RateBuckets();
  const byDeposit = new RateBuckets();
  let booked = 0;
  let noShows = 0;
  for (const a of appointments) {
    if (!HELD.has(a.status) || !inPeriod(a.startsAt, period) || a.startsAt.getTime() >= now.getTime()) continue;
    if (options.doctorId && a.doctorId !== options.doctorId) continue;
    const source = (a.leadId ? options.leadSources?.get(a.leadId) : undefined) ?? a.patientSource ?? "unknown";
    if (options.source && source !== options.source) continue;
    const missed = a.status === "NO_SHOW";
    booked += 1;
    if (missed) noShows += 1;
    byDoctor.add(a.doctorId ?? "none", labelOf(labels.doctors, a.doctorId, "No doctor"), missed);
    byKind.add(a.kind, APPOINTMENT_KIND_LABELS[a.kind] ?? a.kind, missed);
    const weekday = zonedParts(a.startsAt, timeZone).weekday;
    byWeekday.add(String(weekday), WEEKDAY_LABELS[weekday] ?? String(weekday), missed);
    bySource.add(source, options.sourceLabels?.[source] ?? source, missed);
    const at = a.startsAt.getTime();
    const previous = Math.max(-Infinity, ...(priorByPatient.get(a.patientId) ?? []).filter((t) => t < at));
    const paid = (depositsByPatient.get(a.patientId) ?? []).some(
      (d) => d.appointmentId === a.id || (d.appointmentId === null && d.paidAt.getTime() < at && d.paidAt.getTime() > previous),
    );
    byDeposit.add(paid ? "deposit" : "none", paid ? "Deposit paid" : "No deposit", missed);
  }
  return {
    booked,
    noShows,
    rate: rate(noShows, booked),
    byDoctor: byDoctor.list(),
    byKind: byKind.list(),
    byWeekday: byWeekday.list(WEEKDAY_ORDER),
    bySource: bySource.list(),
    byDeposit: byDeposit.list(["deposit", "none"]),
  };
}

// ── M7 Lost leads ────────────────────────────────────────────────────────────

export interface LostLeads {
  lost: number;
  byReason: CountItem[];
  byStage: CountItem[];
}

export function lostLeads(leads: readonly LeadRow[], period: Period, filters: { source?: string } = {}): LostLeads {
  const reasons = new Map<string, number>(LOST_REASONS.map((r) => [r, 0]));
  const stages = new Map<string, number>();
  let lost = 0;
  for (const lead of leads) {
    if (!lead.lostAt || !inPeriod(lead.lostAt, period)) continue;
    if (filters.source && lead.source !== filters.source) continue;
    lost += 1;
    const reason = lead.lostReason ?? "OTHER";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    const stage = lead.lostAtStage ?? "unknown";
    stages.set(stage, (stages.get(stage) ?? 0) + 1);
  }
  return {
    lost,
    byReason: [...reasons.entries()].map(([key, count]) => ({ key, label: LOST_REASON_LABELS[key as keyof typeof LOST_REASON_LABELS] ?? key, count })),
    byStage: [...stages.entries()]
      .map(([key, count]) => ({ key, label: LEAD_STAGE_LABELS[key as keyof typeof LEAD_STAGE_LABELS] ?? (key === "unknown" ? "Unknown" : key), count }))
      .sort((a, b) => LEAD_STAGES.indexOf(a.key as never) - LEAD_STAGES.indexOf(b.key as never)),
  };
}

// ── M8 Objections ────────────────────────────────────────────────────────────

export interface Objections {
  conversations: number;
  closedLeads: number;
  items: { key: string; label: string; aiCount: number; aiShare: number | null; staffCount: number; staffShare: number | null }[];
}

export function objectionsSideBySide(conversations: readonly ConversationRow[], leads: readonly LeadRow[], period: Period, filters: { source?: string } = {}): Objections {
  const ai = new Map<string, number>();
  const staff = new Map<string, number>();
  let conversationCount = 0;
  for (const c of conversations) {
    if (!inPeriod(c.createdAt, period)) continue;
    conversationCount += 1;
    for (const tag of new Set(c.objections)) ai.set(tag, (ai.get(tag) ?? 0) + 1);
  }
  let closed = 0;
  for (const lead of leads) {
    const closedAt = lead.lostAt ?? lead.wonAt;
    if (!closedAt || !inPeriod(closedAt, period)) continue;
    if (filters.source && lead.source !== filters.source) continue;
    closed += 1;
    for (const tag of new Set(lead.objections)) staff.set(tag, (staff.get(tag) ?? 0) + 1);
  }
  return {
    conversations: conversationCount,
    closedLeads: closed,
    items: OBJECTION_TAGS.map((tag) => ({
      key: tag,
      label: OBJECTION_LABELS[tag],
      aiCount: ai.get(tag) ?? 0,
      aiShare: rate(ai.get(tag) ?? 0, conversationCount),
      staffCount: staff.get(tag) ?? 0,
      staffShare: rate(staff.get(tag) ?? 0, closed),
    })).sort((a, b) => b.aiCount + b.staffCount - (a.aiCount + a.staffCount)),
  };
}

// ── M9 Hair-transplant enquiries by source ───────────────────────────────────

export interface HairTransplantEnquiries {
  leads: number;
  bySource: CountItem[];
  byCampaign: CountItem[];
}

export function hairTransplantBySource(
  leads: readonly LeadRow[],
  period: Period,
  hairKey: string,
  labels: Labels,
  sourceLabels: Record<string, string> = {},
  filters: { source?: string } = {},
): HairTransplantEnquiries {
  const sources = new Map<string, number>();
  const campaigns = new Map<string, number>();
  let total = 0;
  for (const lead of leads) {
    if (!inPeriod(lead.createdAt, period) || !lead.interests.includes(hairKey)) continue;
    if (filters.source && lead.source !== filters.source) continue;
    total += 1;
    sources.set(lead.source, (sources.get(lead.source) ?? 0) + 1);
    const c = lead.campaignId ?? "none";
    campaigns.set(c, (campaigns.get(c) ?? 0) + 1);
  }
  return {
    leads: total,
    bySource: [...sources.entries()].map(([key, count]) => ({ key, label: sourceLabels[key] ?? key, count })).sort(byCountDesc),
    byCampaign: [...campaigns.entries()].map(([key, count]) => ({ key, label: key === "none" ? "No campaign" : labelOf(labels.campaigns, key, key), count })).sort(byCountDesc),
  };
}

// ── M10 Repeat-patient rate ──────────────────────────────────────────────────

export interface PaidVisitRow {
  patientId: string;
  at: Date;
  /** The treatment of a signed procedure; null for a consultation fee. */
  treatmentKey: string | null;
}

export interface RepeatRate {
  cohortFrom: Date;
  cohortTo: Date;
  cohort: number;
  returned: number;
  rate: number | null;
  byFirstTreatment: RateItem[];
}

export const REPEAT_WINDOW_DAYS = 365;

/** Shift a period back one year on the clinic clock (same wall-clock dates). */
export function shiftBackOneYear(period: Period, timeZone: string): Period {
  const shift = (d: Date) => {
    const p = zonedParts(d, timeZone);
    return zonedTimeToUtc({ year: p.year - 1, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second }, timeZone);
  };
  return { from: shift(period.from), to: shift(period.to) };
}

export function repeatPatientRate(
  visits: readonly PaidVisitRow[],
  cohort: Period,
  timeZone: string,
  labels: Labels,
  filters: { treatmentKey?: string } = {},
  windowDays = REPEAT_WINDOW_DAYS,
): RepeatRate {
  const byPatient = new Map<string, PaidVisitRow[]>();
  for (const v of visits) {
    const list = byPatient.get(v.patientId) ?? [];
    list.push(v);
    byPatient.set(v.patientId, list);
  }
  const buckets = new RateBuckets();
  let size = 0;
  let returned = 0;
  for (const list of byPatient.values()) {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    const first = list[0]!;
    if (!inPeriod(first.at, cohort)) continue;
    const firstKey = first.treatmentKey ?? "consultation";
    if (filters.treatmentKey && firstKey !== filters.treatmentKey) continue;
    const firstDay = dateKeyInTz(first.at, timeZone);
    const latest = first.at.getTime() + windowDays * DAY_MS;
    const again = list.some((v) => v.at.getTime() > first.at.getTime() && v.at.getTime() <= latest && dateKeyInTz(v.at, timeZone) !== firstDay);
    size += 1;
    if (again) returned += 1;
    buckets.add(firstKey, firstKey === "consultation" ? "Consultation only" : labelOf(labels.treatments, firstKey, firstKey), again);
  }
  return { cohortFrom: cohort.from, cohortTo: cohort.to, cohort: size, returned, rate: rate(returned, size), byFirstTreatment: buckets.list() };
}

// ── M11 Satisfaction ─────────────────────────────────────────────────────────

export interface ScoreStat {
  avg: number | null;
  n: number;
}

export interface Satisfaction {
  hairMonth1: ScoreStat;
  hairMonth12: ScoreStat;
  othersDay14: ScoreStat;
  overall: ScoreStat;
  byTreatment: (ScoreStat & { key: string; label: string })[];
}

const score = (values: number[]): ScoreStat => ({ avg: average(values), n: values.length });

export function satisfactionScores(checkIns: readonly CheckInRow[], period: Period, hairKey: string, labels: Labels, filters: { treatmentKey?: string } = {}): Satisfaction {
  const rows = checkIns.filter((c) => c.satisfaction !== null && inPeriod(c.submittedAt, period) && (!filters.treatmentKey || c.treatmentKey === filters.treatmentKey));
  const val = (c: CheckInRow) => c.satisfaction ?? 0;
  const hair = rows.filter((c) => c.treatmentKey === hairKey);
  const others = rows.filter((c) => c.treatmentKey !== hairKey);
  const byTreatment = new Map<string, number[]>();
  for (const c of rows) {
    const list = byTreatment.get(c.treatmentKey) ?? [];
    list.push(val(c));
    byTreatment.set(c.treatmentKey, list);
  }
  return {
    hairMonth1: score(hair.filter((c) => c.offsetDays >= 20 && c.offsetDays <= 45).map(val)),
    hairMonth12: score(hair.filter((c) => c.offsetDays >= 300 && c.offsetDays <= 430).map(val)),
    othersDay14: score(others.filter((c) => c.offsetDays >= 10 && c.offsetDays <= 20).map(val)),
    overall: score(rows.map(val)),
    byTreatment: [...byTreatment.entries()].map(([key, values]) => ({ key, label: labelOf(labels.treatments, key, key), ...score(values) })).sort((a, b) => b.n - a.n),
  };
}

export interface ReviewTrend {
  latest: ReviewRow | null;
  previous: ReviewRow | null;
  trend: ReviewRow[];
  newReviews: number | null;
}

/** Latest snapshot and the 12-week trend (one row per week, newest last). */
export function reviewTrend(rows: readonly ReviewRow[]): ReviewTrend {
  const byWeek = new Map<number, ReviewRow>();
  for (const r of [...rows].sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())) {
    // A Google pull wins over a manual entry for the same week.
    const existing = byWeek.get(r.weekStart.getTime());
    if (!existing || r.source === "GOOGLE_BUSINESS_PROFILE") byWeek.set(r.weekStart.getTime(), r);
  }
  const trend = [...byWeek.values()].slice(-12);
  const latest = trend[trend.length - 1] ?? null;
  const previous = trend[trend.length - 2] ?? null;
  const first = trend[0] ?? null;
  return { latest, previous, trend, newReviews: latest && first && latest !== first ? latest.count - first.count : null };
}

// ── M12 Follow-ups overdue ───────────────────────────────────────────────────

export interface OverdueSummary {
  followUps: number;
  escalations: number;
  byOwner: { key: string; label: string; followUps: number; escalations: number; oldestDueAt: Date }[];
  items: (OverdueRow & { ownerLabel: string; overdueHours: number })[];
}

export function overdueByOwner(rows: readonly OverdueRow[], users: Map<string, string>, now: Date): OverdueSummary {
  const owners = new Map<string, OverdueSummary["byOwner"][number]>();
  let followUps = 0;
  let escalations = 0;
  for (const r of rows) {
    if (r.dueAt.getTime() >= now.getTime()) continue;
    if (r.kind === "follow_up") followUps += 1;
    else escalations += 1;
    const key = r.ownerId ?? "unassigned";
    const o = owners.get(key) ?? { key, label: labelOf(users, r.ownerId, "Unassigned"), followUps: 0, escalations: 0, oldestDueAt: r.dueAt };
    if (r.kind === "follow_up") o.followUps += 1;
    else o.escalations += 1;
    if (r.dueAt < o.oldestDueAt) o.oldestDueAt = r.dueAt;
    owners.set(key, o);
  }
  return {
    followUps,
    escalations,
    byOwner: [...owners.values()].sort((a, b) => b.followUps + b.escalations - (a.followUps + a.escalations)),
    items: rows
      .filter((r) => r.dueAt.getTime() < now.getTime())
      .map((r) => ({ ...r, ownerLabel: labelOf(users, r.ownerId, "Unassigned"), overdueHours: Math.floor((now.getTime() - r.dueAt.getTime()) / 3_600_000) }))
      .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
      .slice(0, 50),
  };
}

// ── M13 Campaign → procedure ─────────────────────────────────────────────────

export interface CampaignResult {
  campaignId: string;
  label: string;
  platform: string;
  leads: number;
  consultations: number;
  procedures: number;
  revenue: number;
  cost: number;
  costPerLead: number | null;
  costPerProcedure: number | null;
}

export interface CampaignFunnel {
  items: CampaignResult[];
  totals: { leads: number; consultations: number; procedures: number; revenue: number; cost: number };
}

/** The share of a cost row's days that fall inside the period, times its amount. Cost dates are calendar dates read on the clinic clock. */
export function prorateCost(cost: CampaignCostRow, period: Period, timeZone = "UTC"): number {
  const day = (d: Date, plusDays = 0) => zonedTimeToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() + plusDays }, timeZone).getTime();
  const start = day(cost.periodStart);
  const end = day(cost.periodEnd, 1);
  const total = end - start;
  if (total <= 0) return 0;
  const overlap = Math.min(end, period.to.getTime()) - Math.max(start, period.from.getTime());
  if (overlap <= 0) return 0;
  return (cost.amount * overlap) / total;
}

export function campaignToProcedure(
  campaigns: readonly CampaignRow[],
  leads: readonly LeadRow[],
  consultationAt: Map<string, Date>,
  procedures: readonly ProcedureRow[],
  costs: readonly CampaignCostRow[],
  period: Period,
  timeZone: string,
  filters: { source?: string; treatmentKey?: string } = {},
  windowDays = PROCEDURE_WINDOW_DAYS,
): CampaignFunnel {
  const items = new Map<string, CampaignResult & { procedureIds: Set<string> }>();
  for (const c of campaigns) {
    items.set(c.id, { campaignId: c.id, label: c.name, platform: c.platform, leads: 0, consultations: 0, procedures: 0, revenue: 0, cost: 0, costPerLead: null, costPerProcedure: null, procedureIds: new Set() });
  }
  for (const lead of leads) {
    if (!lead.campaignId || !inPeriod(lead.createdAt, period)) continue;
    if (filters.source && lead.source !== filters.source) continue;
    const item = items.get(lead.campaignId);
    if (!item) continue;
    item.leads += 1;
    const at = consultationAt.get(lead.id);
    if (!at) continue;
    item.consultations += 1;
    if (!lead.patientId) continue;
    const latest = at.getTime() + windowDays * DAY_MS;
    for (const p of procedures) {
      if (p.patientId !== lead.patientId || item.procedureIds.has(p.id)) continue;
      if (filters.treatmentKey && p.treatmentKey !== filters.treatmentKey) continue;
      const t = p.performedAt.getTime();
      if (t < at.getTime() - DAY_MS || t > latest) continue;
      item.procedureIds.add(p.id);
      item.procedures += 1;
      item.revenue += p.price - p.discount;
    }
  }
  for (const cost of costs) {
    const item = items.get(cost.campaignId);
    if (item) item.cost += prorateCost(cost, period, timeZone);
  }
  const list = [...items.values()]
    .map(({ procedureIds: _ids, ...item }) => ({
      ...item,
      cost: Math.round(item.cost),
      costPerLead: item.leads ? Math.round(item.cost / item.leads) : null,
      costPerProcedure: item.procedures ? Math.round(item.cost / item.procedures) : null,
    }))
    .filter((i) => i.leads || i.cost || i.procedures)
    .sort((a, b) => b.leads - a.leads || b.cost - a.cost);
  const totals = list.reduce(
    (t, i) => ({ leads: t.leads + i.leads, consultations: t.consultations + i.consultations, procedures: t.procedures + i.procedures, revenue: t.revenue + i.revenue, cost: t.cost + i.cost }),
    { leads: 0, consultations: 0, procedures: 0, revenue: 0, cost: 0 },
  );
  return { items: list, totals };
}

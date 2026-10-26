import { dateKeyInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
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
  /** The treatment the booking is for (set when a lead books a consultation), as a key. */
  treatmentKey?: string | null;
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
  /** Doctor and treatment of the linked procedure (any status), for the M4 filters. */
  procedureDoctorId?: string | null;
  procedureTreatmentKey?: string | null;
}

export interface MessageRow {
  conversationId: string;
  direction: string;
  /** PATIENT | AI | HUMAN | SYSTEM. Only AI and HUMAN outbound messages are replies. */
  author: string;
  createdAt: Date;
  channel: string;
}

export interface ConversationRow {
  id: string;
  createdAt: Date;
  objections: string[];
  /** First-touch source of the linked lead, for the source filter. */
  leadSource?: string | null;
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

/** A patient attended an appointment once they were checked in. */
export const ATTENDED_STATUSES: ReadonlySet<string> = new Set(["CHECKED_IN", "IN_PROGRESS", "COMPLETED"]);

/** An attended consultation: kind CONSULTATION, checked in, in progress or completed. */
export const isAttendedConsultation = (a: Pick<AppointmentRow, "kind" | "status">): boolean => a.kind === "CONSULTATION" && ATTENDED_STATUSES.has(a.status);

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
    return items.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
  }
}

/** Signed procedures grouped by patient, earliest first (the lookups of M3 and M13). */
export function indexProcedures(procedures: readonly ProcedureRow[]): Map<string, ProcedureRow[]> {
  const out = new Map<string, ProcedureRow[]>();
  for (const p of procedures) {
    const list = out.get(p.patientId) ?? [];
    list.push(p);
    out.set(p.patientId, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.performedAt.getTime() - b.performedAt.getTime());
  return out;
}

/**
 * The window "within N days after `at`": from the start of the clinic day of
 * `at` (a same-day procedure entered for the morning still counts) to `at` + N days.
 */
function windowAfter(at: Date, windowDays: number, timeZone: string): { from: number; to: number } {
  return { from: startOfDayInTz(at, timeZone).getTime(), to: at.getTime() + windowDays * DAY_MS };
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

/**
 * Leads created in the period with an attended consultation within 30 days:
 * the lead's own consultation booking, else any attended consultation of the
 * linked patient, from the lead's clinic day up to 30 days after it was created.
 */
export function leadToConsultation(
  leads: readonly LeadRow[],
  appointments: readonly AppointmentRow[],
  period: Period,
  options: { sourceLabels?: Record<string, string>; timeZone?: string; windowDays?: number } = {},
): LeadConversion {
  const { sourceLabels = {}, timeZone = "UTC", windowDays = LEAD_WINDOW_DAYS } = options;
  const byId = new Map(appointments.map((a) => [a.id, a]));
  const consultationsByPatient = new Map<string, AppointmentRow[]>();
  for (const a of appointments) {
    if (!isAttendedConsultation(a)) continue;
    const list = consultationsByPatient.get(a.patientId) ?? [];
    list.push(a);
    consultationsByPatient.set(a.patientId, list);
  }
  for (const list of consultationsByPatient.values()) list.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const buckets = new RateBuckets();
  const consultationAt = new Map<string, Date>();
  let total = 0;
  for (const lead of leads) {
    if (!inPeriod(lead.createdAt, period)) continue;
    total += 1;
    const win = windowAfter(lead.createdAt, windowDays, timeZone);
    const within = (a: AppointmentRow) => a.startsAt.getTime() >= win.from && a.startsAt.getTime() <= win.to;
    let hit: Date | null = null;
    const booked = lead.consultationAppointmentId ? byId.get(lead.consultationAppointmentId) : undefined;
    if (booked && ATTENDED_STATUSES.has(booked.status) && within(booked)) hit = booked.startsAt;
    if (!hit && lead.patientId) {
      const first = (consultationsByPatient.get(lead.patientId) ?? []).find(within);
      if (first) hit = first.startsAt;
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
  /** By the consulting doctor. */
  byDoctor: RateItem[];
  /** By the treatment the consultation was booked for (the booking's treatment, else the lead's first interest). */
  byTreatment: RateItem[];
  /** Converted consultations by the treatment of the procedure that followed. */
  byProcedureTreatment: CountItem[];
}

export const PROCEDURE_WINDOW_DAYS = 60;

/** The first signed procedure of the patient within `windowDays` after `at` (same clinic day included), or null. */
function procedureAfter(
  byPatient: Map<string, ProcedureRow[]>,
  patientId: string,
  at: Date,
  windowDays: number,
  timeZone: string,
  treatmentKey?: string,
): ProcedureRow | null {
  const win = windowAfter(at, windowDays, timeZone);
  for (const p of byPatient.get(patientId) ?? []) {
    const t = p.performedAt.getTime();
    if (t < win.from) continue;
    if (t > win.to) break;
    if (treatmentKey && p.treatmentKey !== treatmentKey) continue;
    return p;
  }
  return null;
}

/**
 * Attended consultations in the period followed by a SIGNED procedure for the
 * same patient within 60 days, divided by attended consultations. With a
 * treatment filter the consultations booked for that treatment (or for no
 * stated treatment) count, and only a procedure of that treatment converts.
 */
export function consultationToProcedure(
  appointments: readonly AppointmentRow[],
  procedures: readonly ProcedureRow[],
  period: Period,
  labels: Labels,
  filters: { doctorId?: string; treatmentKey?: string } = {},
  options: { timeZone?: string; windowDays?: number; leadInterests?: Map<string, string[]>; procedureIndex?: Map<string, ProcedureRow[]> } = {},
): ConsultationConversion {
  const { timeZone = "UTC", windowDays = PROCEDURE_WINDOW_DAYS, leadInterests } = options;
  const index = options.procedureIndex ?? indexProcedures(procedures);
  const byDoctor = new RateBuckets();
  const byTreatment = new RateBuckets();
  const byProcedureTreatment = new Map<string, number>();
  let total = 0;
  let converted = 0;
  for (const a of appointments) {
    if (!isAttendedConsultation(a) || !inPeriod(a.startsAt, period)) continue;
    if (filters.doctorId && a.doctorId !== filters.doctorId) continue;
    const stated = a.treatmentKey ?? (a.leadId ? (leadInterests?.get(a.leadId)?.[0] ?? null) : null);
    if (filters.treatmentKey && stated && stated !== filters.treatmentKey) continue;
    total += 1;
    const hit = procedureAfter(index, a.patientId, a.startsAt, windowDays, timeZone, filters.treatmentKey);
    if (hit) {
      converted += 1;
      byProcedureTreatment.set(hit.treatmentKey, (byProcedureTreatment.get(hit.treatmentKey) ?? 0) + 1);
    }
    byDoctor.add(a.doctorId ?? "none", labelOf(labels.doctors, a.doctorId, "No doctor"), hit !== null);
    byTreatment.add(stated ?? "unspecified", stated ? labelOf(labels.treatments, stated, stated) : "Not specified", hit !== null);
  }
  return {
    consultations: total,
    converted,
    rate: rate(converted, total),
    byDoctor: byDoctor.list(),
    byTreatment: byTreatment.list(),
    byProcedureTreatment: [...byProcedureTreatment.entries()].map(([key, count]) => ({ key, label: labelOf(labels.treatments, key, key), count })).sort(byCountDesc),
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

/**
 * Revenue of signed procedures by the date performed (price − discount), by
 * doctor and treatment; deposits, refunds and consultation fees as their own
 * lines by the date paid. A doctor or treatment filter narrows the money lines
 * to payments linked to a matching procedure (or, for consultation fees, to a
 * matching appointment).
 */
export function revenueBreakdown(
  procedures: readonly ProcedureRow[],
  payments: readonly PaymentRow[],
  period: Period,
  labels: Labels,
  filters: { doctorId?: string; treatmentKey?: string } = {},
  appointmentsById: Map<string, AppointmentRow> = new Map(),
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
  const filtered = Boolean(filters.doctorId || filters.treatmentKey);
  const matches = (pay: PaymentRow): boolean => {
    if (!filtered) return true;
    let doctorId: string | null = null;
    let treatmentKey: string | null = null;
    if (pay.procedureId) {
      doctorId = pay.procedureDoctorId ?? null;
      treatmentKey = pay.procedureTreatmentKey ?? null;
    } else if (pay.appointmentId) {
      const a = appointmentsById.get(pay.appointmentId);
      if (!a) return false;
      doctorId = a.doctorId;
      treatmentKey = a.treatmentKey ?? null;
    } else return false;
    if (filters.doctorId && doctorId !== filters.doctorId) return false;
    if (filters.treatmentKey && treatmentKey !== filters.treatmentKey) return false;
    return true;
  };
  let deposits = 0;
  let refunds = 0;
  let consultationFees = 0;
  for (const pay of payments) {
    if (!inPeriod(pay.paidAt, period) || !matches(pay)) continue;
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
  /** Inbound messages in the period still waiting for a reply. */
  unanswered: number;
}

const stats = (values: number[]): ResponseStats => ({ n: values.length, p50: percentile(values, 50), p90: percentile(values, 90) });

/** Replies recorded before the author column existed carry `meta.by = "ai"`; read them as the AI's. */
export function messageAuthor(author: string, meta: unknown): string {
  if (author === "HUMAN" && meta && typeof meta === "object" && (meta as { by?: unknown }).by === "ai") return "AI";
  return author;
}

/** Reply authors: an outbound message written by the AI or by a person. Automated sends (SYSTEM) are not replies. */
const REPLY_AUTHORS = new Set(["AI", "HUMAN"]);

/**
 * Seconds from an inbound message to the first reply that follows it in the
 * same conversation. A run of inbound messages before a reply is one wait,
 * timed from its first message (the patient waited from then). The sample
 * belongs to the period, channel and clinic hour of that first message.
 */
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
    let waiting: MessageRow | null = null;
    for (const m of list) {
      if (m.direction === "INBOUND") {
        waiting ??= m;
        continue;
      }
      if (!REPLY_AUTHORS.has(m.author) || !waiting) continue;
      if (inPeriod(waiting.createdAt, period)) {
        samples.push({
          seconds: Math.max(0, Math.round((m.createdAt.getTime() - waiting.createdAt.getTime()) / 1000)),
          who: m.author === "HUMAN" ? "human" : "ai",
          channel: waiting.channel,
          hour: zonedParts(waiting.createdAt, timeZone).hour,
        });
      }
      waiting = null;
    }
    if (waiting && inPeriod(waiting.createdAt, period)) unanswered += 1;
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

/** Booked appointments: every status except CANCELLED and WAITLISTED. */
export const HELD_STATUSES: ReadonlySet<string> = new Set(["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW"]);
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
  const prior = options.priorAppointments ?? appointments.filter((a) => HELD_STATUSES.has(a.status));
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
    if (!HELD_STATUSES.has(a.status) || !inPeriod(a.startsAt, period) || a.startsAt.getTime() >= now.getTime()) continue;
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
    let previous = -Infinity;
    for (const t of priorByPatient.get(a.patientId) ?? []) if (t < at && t > previous) previous = t;
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
  const stageOrder = (key: string) => {
    const i = LEAD_STAGES.indexOf(key as (typeof LEAD_STAGES)[number]);
    return i === -1 ? LEAD_STAGES.length : i;
  };
  return {
    lost,
    byReason: [...reasons.entries()].map(([key, count]) => ({ key, label: LOST_REASON_LABELS[key as keyof typeof LOST_REASON_LABELS] ?? key, count })),
    byStage: [...stages.entries()]
      .map(([key, count]) => ({ key, label: LEAD_STAGE_LABELS[key as keyof typeof LEAD_STAGE_LABELS] ?? (key === "unknown" ? "Unknown" : key), count }))
      .sort((a, b) => stageOrder(a.key) - stageOrder(b.key)),
  };
}

// ── M8 Objections ────────────────────────────────────────────────────────────

export interface Objections {
  /** Conversations opened in the period. */
  conversations: number;
  /** Of which the AI tagged at least one objection. */
  taggedConversations: number;
  closedLeads: number;
  items: { key: string; label: string; aiCount: number; aiShare: number | null; staffCount: number; staffShare: number | null }[];
}

/**
 * The AI's objection tags on conversations opened in the period next to the
 * objections staff confirmed on leads closed (won or lost) in the period; each
 * share is of all conversations / all closed leads.
 */
export function objectionsSideBySide(conversations: readonly ConversationRow[], leads: readonly LeadRow[], period: Period, filters: { source?: string } = {}): Objections {
  const ai = new Map<string, number>();
  const staff = new Map<string, number>();
  let conversationCount = 0;
  let tagged = 0;
  for (const c of conversations) {
    if (!inPeriod(c.createdAt, period)) continue;
    if (filters.source && c.leadSource !== filters.source) continue;
    conversationCount += 1;
    const tags = new Set(c.objections);
    if (tags.size) tagged += 1;
    for (const tag of tags) ai.set(tag, (ai.get(tag) ?? 0) + 1);
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
    taggedConversations: tagged,
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

/**
 * Patients whose first paid visit (a signed procedure or a consultation fee)
 * falls in the cohort period, and the share who had a second paid visit on a
 * later clinic day within 12 months of the first. The first treatment is the
 * procedure of that first day (a consultation fee alone is "Consultation only").
 */
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
    const firstDay = dateKeyInTz(first.at, timeZone);
    const firstProcedure = list.find((v) => v.treatmentKey !== null && dateKeyInTz(v.at, timeZone) === firstDay);
    const firstKey = firstProcedure?.treatmentKey ?? "consultation";
    if (filters.treatmentKey && firstKey !== filters.treatmentKey) continue;
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

/**
 * Per campaign: leads created in the period, consultations attended (the M2
 * rule), SIGNED procedures within 60 days of that consultation and their
 * revenue, the campaign cost overlapping the period (pro-rated by days) and
 * the cost per lead and per procedure.
 */
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
  procedureIndex?: Map<string, ProcedureRow[]>,
): CampaignFunnel {
  const index = procedureIndex ?? indexProcedures(procedures);
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
    const win = windowAfter(at, windowDays, timeZone);
    for (const p of index.get(lead.patientId) ?? []) {
      const t = p.performedAt.getTime();
      if (t < win.from) continue;
      if (t > win.to) break;
      if (item.procedureIds.has(p.id)) continue;
      if (filters.treatmentKey && p.treatmentKey !== filters.treatmentKey) continue;
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

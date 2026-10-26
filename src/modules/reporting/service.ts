import { db, notDeleted } from "@/lib/db";
import { getTenantTimezone } from "@/modules/appointments/service";
import { HAIR_TRANSPLANT_KEY } from "@/modules/treatments/service";
import {
  campaignToProcedure,
  consultationToProcedure,
  enquiriesByTreatment,
  firstResponseTimes,
  hairTransplantBySource,
  HELD_STATUSES,
  indexProcedures,
  leadToConsultation,
  lostLeads,
  messageAuthor,
  noShowBreakdown,
  objectionsSideBySide,
  overdueByOwner,
  repeatPatientRate,
  revenueBreakdown,
  reviewTrend,
  satisfactionScores,
  shiftBackOneYear,
  type AppointmentRow,
  type CampaignCostRow,
  type CampaignFunnel,
  type CampaignRow,
  type CheckInRow,
  type ConsultationConversion,
  type ConversationRow,
  type Enquiries,
  type FirstResponse,
  type HairTransplantEnquiries,
  type Labels,
  type LeadRow,
  type LostLeads,
  type MessageRow,
  type NoShow,
  type Objections,
  type OverdueRow,
  type OverdueSummary,
  type PaidVisitRow,
  type PaymentRow,
  type ProcedureRow,
  type RepeatRate,
  type Revenue,
  type ReviewRow,
  type ReviewTrend,
  type Satisfaction,
} from "./metrics";
import type { Period, ResolvedPeriod } from "./period";
import { filtersFromQuery, periodFromQuery, SOURCE_LABELS, type ReportFilters, type ReportQuery } from "./query";

/**
 * The reports service: fetch every row the thirteen metrics need for a period
 * and its comparison period in one round of tenant-scoped queries, then hand
 * them to the pure functions in metrics.ts. The same `getReport` serves the
 * page, the JSON endpoint, the CSV export, the alert rules and the weekly brief.
 */

const DAY_MS = 86_400_000;
const ROW_CAP = 50_000;

export interface Pair<T> {
  current: T;
  previous: T;
}

export interface PeriodInfo {
  preset: string;
  from: Date;
  to: Date;
  fromKey: string;
  toKey: string;
  days: number;
  label: string;
}

export type LeadConversionView = Omit<ReturnType<typeof leadToConsultation>, "consultationAt">;

export interface Report {
  timeZone: string;
  generatedAt: Date;
  period: PeriodInfo;
  previous: { from: Date; to: Date; fromKey: string; toKey: string };
  filters: ReportFilters;
  /** Revenue figures (M4, M13 money) stripped for roles without finance:read. */
  redacted: boolean;
  m1: Pair<Enquiries>;
  m2: Pair<LeadConversionView>;
  m3: Pair<ConsultationConversion>;
  m4: Pair<Revenue> | null;
  m5: Pair<FirstResponse>;
  m6: Pair<NoShow>;
  m7: Pair<LostLeads>;
  m8: Pair<Objections>;
  m9: Pair<HairTransplantEnquiries>;
  m10: Pair<RepeatRate>;
  m11: Pair<Satisfaction> & { reviews: ReviewTrend };
  m12: OverdueSummary;
  m13: Pair<CampaignFunnel>;
}

export interface ReportRows {
  leads: LeadRow[];
  appointments: AppointmentRow[];
  priorAppointments: { patientId: string; startsAt: Date }[];
  procedures: ProcedureRow[];
  payments: PaymentRow[];
  messages: MessageRow[];
  conversations: ConversationRow[];
  checkIns: CheckInRow[];
  reviews: ReviewRow[];
  overdue: OverdueRow[];
  campaigns: CampaignRow[];
  costs: CampaignCostRow[];
  labels: Labels;
  users: Map<string, string>;
  hairKey: string;
}

/** Every row the metrics need for the period, its comparison period and the lookahead windows. */
export async function fetchReportRows(tenantId: string, period: ResolvedPeriod, filters: ReportFilters, now: Date): Promise<ReportRows> {
  const spanFrom = period.previous.from;
  const spanTo = period.to;
  const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
  const minus = (d: Date, days: number) => new Date(d.getTime() - days * DAY_MS);
  const span = { gte: spanFrom, lt: spanTo };
  const leadFilter = filters.source ? { source: filters.source } : {};

  const [leads, appointments, procedures, payments, messages, conversations, checkIns, reviews, followUps, escalations, campaigns, costs, users, treatments] = await Promise.all([
    db.lead.findMany({
      where: { tenantId, ...notDeleted, ...leadFilter, OR: [{ createdAt: span }, { lostAt: span }, { wonAt: span }] },
      select: { id: true, createdAt: true, source: true, campaignId: true, interests: true, patientId: true, consultationAppointmentId: true, stage: true, lostReason: true, lostAtStage: true, lostAt: true, wonAt: true, objections: true },
      take: ROW_CAP,
    }),
    db.appointment.findMany({
      where: { tenantId, ...notDeleted, startsAt: { gte: minus(spanFrom, 1), lt: plus(spanTo, 31) } },
      select: { id: true, patientId: true, doctorId: true, kind: true, status: true, startsAt: true, leadId: true, treatmentId: true, patient: { select: { source: true } } },
      take: ROW_CAP,
    }),
    db.procedure.findMany({
      where: { tenantId, ...notDeleted, status: "SIGNED" },
      select: { id: true, patientId: true, doctorId: true, performedAt: true, price: true, discount: true, treatment: { select: { key: true } } },
      take: ROW_CAP,
    }),
    db.payment.findMany({
      where: {
        tenantId,
        ...notDeleted,
        OR: [{ paidAt: span }, { kind: "CONSULTATION_FEE" }, { kind: "DEPOSIT", paidAt: { gte: minus(spanFrom, 400), lt: plus(spanTo, 31) } }],
      },
      select: {
        id: true,
        patientId: true,
        kind: true,
        method: true,
        amount: true,
        paidAt: true,
        procedureId: true,
        appointmentId: true,
        procedure: { select: { doctorId: true, treatment: { select: { key: true } } } },
      },
      take: ROW_CAP,
    }),
    // Two days before the span so a wait that started just before it is timed from its first message.
    db.message.findMany({
      where: { tenantId, createdAt: { gte: minus(spanFrom, 2), lt: plus(spanTo, 2) } },
      select: { conversationId: true, direction: true, author: true, meta: true, createdAt: true, conversation: { select: { channel: true } } },
      take: ROW_CAP,
    }),
    db.conversation.findMany({
      where: { tenantId, createdAt: span },
      select: { id: true, createdAt: true, objections: true, lead: { select: { source: true } } },
      take: ROW_CAP,
    }),
    db.checkIn.findMany({
      where: { tenantId, submittedAt: span, satisfaction: { not: null } },
      select: {
        satisfaction: true,
        submittedAt: true,
        task: { select: { dueAt: true } },
        enrolment: { select: { startedAt: true, procedure: { select: { treatment: { select: { key: true } } } } } },
      },
      take: ROW_CAP,
    }),
    db.reviewSnapshot.findMany({ where: { tenantId }, orderBy: { weekStart: "desc" }, take: 40 }),
    db.leadFollowUp.findMany({
      where: { tenantId, doneAt: null, dueAt: { lt: now }, lead: { deletedAt: null } },
      select: { id: true, ownerId: true, dueAt: true, note: true, leadId: true, lead: { select: { fullName: true, ownerId: true } } },
      orderBy: { dueAt: "asc" },
      take: 2000,
    }),
    // Concierge escalations past their acknowledgement target. Lead-follow-up escalations are left out:
    // they mirror an overdue follow-up that is already counted.
    db.escalation.findMany({
      where: { tenantId, status: "OPEN", kind: { not: "LEAD_FOLLOW_UP" }, dueAt: { lt: now } },
      select: { id: true, assignedToId: true, dueAt: true, summary: true, patientId: true, leadId: true },
      orderBy: { dueAt: "asc" },
      take: 2000,
    }),
    db.campaign.findMany({ where: { tenantId }, select: { id: true, name: true, platform: true, treatment: { select: { key: true } } }, take: 2000 }),
    db.campaignCost.findMany({
      where: { tenantId, periodEnd: { gte: minus(spanFrom, 1) }, periodStart: { lte: spanTo } },
      select: { campaignId: true, periodStart: true, periodEnd: true, amount: true },
      take: 20_000,
    }),
    db.user.findMany({ where: { tenantId }, select: { id: true, fullName: true, email: true } }),
    db.treatment.findMany({ where: { tenantId }, select: { id: true, key: true, name: true } }),
  ]);

  const treatmentKeyById = new Map(treatments.map((t) => [t.id, t.key]));
  const appointmentRows: AppointmentRow[] = appointments.map((a) => ({
    id: a.id,
    patientId: a.patientId,
    doctorId: a.doctorId,
    kind: a.kind,
    status: a.status,
    startsAt: a.startsAt,
    leadId: a.leadId,
    patientSource: a.patient.source,
    treatmentKey: a.treatmentId ? (treatmentKeyById.get(a.treatmentId) ?? null) : null,
  }));

  // Earlier held appointments of the patients in the no-show window (for the "deposit after the previous appointment" rule).
  const patientIds = [...new Set(appointmentRows.filter((a) => a.startsAt < now).map((a) => a.patientId))];
  const prior = patientIds.length
    ? await db.appointment.findMany({
        where: { tenantId, ...notDeleted, patientId: { in: patientIds }, startsAt: { lt: minus(spanFrom, 1) }, status: { notIn: ["CANCELLED", "WAITLISTED"] } },
        select: { patientId: true, startsAt: true },
        take: ROW_CAP,
      })
    : [];

  const userNames = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  return {
    leads,
    appointments: appointmentRows,
    priorAppointments: [...prior, ...appointmentRows.filter((a) => HELD_STATUSES.has(a.status)).map((a) => ({ patientId: a.patientId, startsAt: a.startsAt }))],
    procedures: procedures.map((p) => ({ id: p.id, patientId: p.patientId, doctorId: p.doctorId, treatmentKey: p.treatment.key, performedAt: p.performedAt, price: p.price, discount: p.discount })),
    payments: payments.map(({ procedure, ...p }) => ({ ...p, procedureDoctorId: procedure?.doctorId ?? null, procedureTreatmentKey: procedure?.treatment.key ?? null })),
    messages: messages.map((m) => ({ conversationId: m.conversationId, direction: m.direction, author: messageAuthor(m.author, m.meta), createdAt: m.createdAt, channel: m.conversation.channel })),
    conversations: conversations.map((c) => ({ id: c.id, createdAt: c.createdAt, objections: c.objections, leadSource: c.lead?.source ?? null })),
    checkIns: checkIns.map((c) => ({
      satisfaction: c.satisfaction,
      submittedAt: c.submittedAt,
      offsetDays: (c.task.dueAt.getTime() - c.enrolment.startedAt.getTime()) / DAY_MS,
      treatmentKey: c.enrolment.procedure.treatment.key,
    })),
    reviews,
    overdue: [
      ...followUps.map((f): OverdueRow => ({ kind: "follow_up", id: f.id, ownerId: f.ownerId ?? f.lead.ownerId, dueAt: f.dueAt, subject: `${f.lead.fullName}${f.note ? ` — ${f.note}` : ""}`, href: `/dashboard/leads/${f.leadId}` })),
      ...escalations.map((e): OverdueRow => ({ kind: "escalation", id: e.id, ownerId: e.assignedToId, dueAt: e.dueAt, subject: e.summary, href: e.patientId ? `/dashboard/patients/${e.patientId}` : "/dashboard/concierge" })),
    ],
    campaigns: campaigns.map((c) => ({ id: c.id, name: c.name, platform: c.platform, treatmentKey: c.treatment?.key ?? null })),
    costs,
    labels: { doctors: userNames, treatments: new Map(treatments.map((t) => [t.key, t.name])), campaigns: new Map(campaigns.map((c) => [c.id, c.name])) },
    users: userNames,
    hairKey: HAIR_TRANSPLANT_KEY,
  };
}

/** Assemble the report from fetched rows. Pure apart from the clock passed in. */
export function computeReport(rows: ReportRows, period: ResolvedPeriod, filters: ReportFilters, timeZone: string, now: Date): Report {
  const current: Period = { from: period.from, to: period.to };
  const previous: Period = period.previous;
  const leadSources = new Map(rows.leads.map((l) => [l.id, l.source]));
  const paidVisits: PaidVisitRow[] = [
    ...rows.procedures.map((p) => ({ patientId: p.patientId, at: p.performedAt, treatmentKey: p.treatmentKey })),
    ...rows.payments.filter((p) => p.kind === "CONSULTATION_FEE").map((p) => ({ patientId: p.patientId, at: p.paidAt, treatmentKey: null })),
  ];
  const doctorFilter = filters.doctorId ? { doctorId: filters.doctorId } : {};
  const treatmentFilter = filters.treatmentKey ? { treatmentKey: filters.treatmentKey } : {};
  const sourceFilter = filters.source ? { source: filters.source } : {};

  const appointmentsById = new Map(rows.appointments.map((a) => [a.id, a]));
  const leadInterests = new Map(rows.leads.map((l) => [l.id, l.interests]));
  const procedureIndex = indexProcedures(rows.procedures);

  const perPeriod = (p: Period) => {
    const m2 = leadToConsultation(rows.leads, rows.appointments, p, { sourceLabels: SOURCE_LABELS, timeZone });
    const { consultationAt, ...m2View } = m2;
    return {
      m1: enquiriesByTreatment(rows.leads, p, rows.labels, filters.treatmentKey),
      m2: m2View,
      m3: consultationToProcedure(rows.appointments, rows.procedures, p, rows.labels, { ...doctorFilter, ...treatmentFilter }, { timeZone, leadInterests, procedureIndex }),
      m4: revenueBreakdown(rows.procedures, rows.payments, p, rows.labels, { ...doctorFilter, ...treatmentFilter }, appointmentsById),
      m5: firstResponseTimes(rows.messages, p, timeZone),
      m6: noShowBreakdown(rows.appointments, p, now, rows.payments, {
        leadSources,
        priorAppointments: rows.priorAppointments,
        labels: rows.labels,
        sourceLabels: SOURCE_LABELS,
        timeZone,
        ...doctorFilter,
        ...sourceFilter,
      }),
      m7: lostLeads(rows.leads, p, sourceFilter),
      m8: objectionsSideBySide(rows.conversations, rows.leads, p, sourceFilter),
      m9: hairTransplantBySource(rows.leads, p, rows.hairKey, rows.labels, SOURCE_LABELS, sourceFilter),
      m10: repeatPatientRate(paidVisits, shiftBackOneYear(p, timeZone), timeZone, rows.labels, treatmentFilter),
      m11: satisfactionScores(rows.checkIns, p, rows.hairKey, rows.labels, treatmentFilter),
      m13: campaignToProcedure(rows.campaigns, rows.leads, consultationAt, rows.procedures, rows.costs, p, timeZone, { ...sourceFilter, ...treatmentFilter }, undefined, procedureIndex),
    };
  };
  const cur = perPeriod(current);
  const prev = perPeriod(previous);
  const pair = <K extends keyof typeof cur>(key: K): Pair<(typeof cur)[K]> => ({ current: cur[key], previous: prev[key] });

  return {
    timeZone,
    generatedAt: now,
    period: { preset: period.preset, from: period.from, to: period.to, fromKey: period.fromKey, toKey: period.toKey, days: period.days, label: period.label },
    previous: {
      from: previous.from,
      to: previous.to,
      fromKey: dateKey(previous.from, timeZone),
      toKey: dateKey(new Date(previous.to.getTime() - 1), timeZone),
    },
    filters,
    redacted: false,
    m1: pair("m1"),
    m2: pair("m2"),
    m3: pair("m3"),
    m4: pair("m4"),
    m5: pair("m5"),
    m6: pair("m6"),
    m7: pair("m7"),
    m8: pair("m8"),
    m9: pair("m9"),
    m10: pair("m10"),
    m11: { ...pair("m11"), reviews: reviewTrend(rows.reviews) },
    m12: overdueByOwner(rows.overdue, rows.users, now),
    m13: pair("m13"),
  };
}

function dateKey(d: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return p;
}

/** Strip the money a role without finance:read must not see. */
export function redactRevenue(report: Report): Report {
  const strip = (f: CampaignFunnel): CampaignFunnel => ({
    items: f.items.map((i) => ({ ...i, revenue: 0, cost: 0, costPerLead: null, costPerProcedure: null })),
    totals: { ...f.totals, revenue: 0, cost: 0 },
  });
  return { ...report, redacted: true, m4: null, m13: { current: strip(report.m13.current), previous: strip(report.m13.previous) } };
}

export interface GetReportOptions {
  now?: Date;
  /** The caller may see revenue (finance:read). */
  canSeeRevenue?: boolean;
}

export async function getReport(tenantId: string, query: ReportQuery, opts: GetReportOptions = {}): Promise<Report> {
  const now = opts.now ?? new Date();
  const timeZone = await getTenantTimezone(tenantId);
  const period = periodFromQuery(query, timeZone, now);
  const filters = filtersFromQuery(query);
  return getReportForPeriod(tenantId, period, filters, { now, timeZone, canSeeRevenue: opts.canSeeRevenue });
}

export async function getReportForPeriod(
  tenantId: string,
  period: ResolvedPeriod,
  filters: ReportFilters,
  opts: { now?: Date; timeZone?: string; canSeeRevenue?: boolean } = {},
): Promise<Report> {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? (await getTenantTimezone(tenantId));
  const rows = await fetchReportRows(tenantId, period, filters, now);
  const report = computeReport(rows, period, filters, timeZone, now);
  return opts.canSeeRevenue === false ? redactRevenue(report) : report;
}

/** Doctors of the tenant for the filter (active clinicians). */
export async function listReportDoctors(tenantId: string): Promise<{ id: string; fullName: string }[]> {
  const users = await db.user.findMany({
    where: { tenantId, ...notDeleted, status: "ACTIVE", role: { in: ["DOCTOR", "CLINIC_OWNER"] } },
    orderBy: [{ fullName: "asc" }],
    select: { id: true, fullName: true, email: true },
    take: 200,
  });
  return users.map((u) => ({ id: u.id, fullName: u.fullName ?? u.email }));
}

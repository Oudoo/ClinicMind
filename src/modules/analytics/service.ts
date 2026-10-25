import type { AppointmentStatus } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { addDays, dateKeyInTz, endOfDayInTz, startOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";

/**
 * Analytics aggregations for the ClinicMind overview dashboard. All queries are
 * tenant-scoped and "today" and every window follow the clinic's timezone, not
 * the server's. Each headline figure carries the same figure for the previous
 * window of equal length, so the dashboard can show the change. Failures
 * degrade to zeroed widgets rather than crashing the dashboard (e.g. before
 * the DB is migrated/seeded).
 */
export interface OverviewMetrics {
  patients: number;
  /** New patient records in the last 7 local days, and in the 7 days before. */
  patientsNew7: number;
  patientsNewPrev7: number;
  appointmentsToday: number;
  appointmentsTodayDone: number;
  appointmentsTodayToCome: number;
  /** Non-cancelled appointments on the same weekday a week ago. */
  appointmentsSameDayLastWeek: number;
  upcoming: number;
  upcoming7: number;
  /** No-show share over the last 14 days and the 14 before, 0..1. */
  noShowRate: number;
  noShowRatePrev: number;
  /** AI runs in the last 7 days and the 7 before. */
  aiInteractions: number;
  aiInteractionsPrev: number;
  activeConsultations: number;
  pendingReview: number;
  /** Visits (signed consultations) in the last 14 days and the 14 before. */
  signedVisits14: number;
  signedVisitsPrev14: number;
  diagnoses: { label: string; count: number }[];
  /** One bucket per local day, oldest first, 14 days ending today. */
  appointmentTrend: { day: string; count: number }[];
  /** New patients per week, oldest first, 8 weeks ending this week. */
  newPatientsWeekly: number[];
}

const ZERO: OverviewMetrics = {
  patients: 0,
  patientsNew7: 0,
  patientsNewPrev7: 0,
  appointmentsToday: 0,
  appointmentsTodayDone: 0,
  appointmentsTodayToCome: 0,
  appointmentsSameDayLastWeek: 0,
  upcoming: 0,
  upcoming7: 0,
  noShowRate: 0,
  noShowRatePrev: 0,
  aiInteractions: 0,
  aiInteractionsPrev: 0,
  activeConsultations: 0,
  pendingReview: 0,
  signedVisits14: 0,
  signedVisitsPrev14: 0,
  diagnoses: [],
  appointmentTrend: [],
  newPatientsWeekly: [],
};

/** Days in the appointment trend and the no-show window, today included. */
const TREND_DAYS = 14;
const WEEKS = 8;

export async function getOverview(tenantId: string): Promise<OverviewMetrics> {
  try {
    const tz = await getTenantTimezone(tenantId);
    const now = new Date();
    const todayStart = startOfDayInTz(now, tz);
    const todayEnd = endOfDayInTz(now, tz);
    // Local windows ending today (midnight on the clinic's clock).
    const d = (daysBack: number) => addDays(todayStart, -daysBack, tz);
    const week = d(6), prevWeek = d(13);
    const fortnight = d(13), prevFortnight = d(27);
    const weeksStart = d(WEEKS * 7 - 1);
    // Expected to happen: cancelled and waitlisted bookings never held a slot.
    const held = { notIn: ["CANCELLED", "WAITLISTED"] satisfies AppointmentStatus[] };

    const [
      patients,
      patientsNew7,
      patientsNewPrev7,
      appointmentsToday,
      appointmentsTodayDone,
      appointmentsTodayToCome,
      appointmentsSameDayLastWeek,
      upcoming,
      upcoming7,
      pastInWindow,
      noShows,
      pastInPrev,
      noShowsPrev,
      aiInteractions,
      aiInteractionsPrev,
      activeConsultations,
      pendingReview,
      signedVisits14,
      signedVisitsPrev14,
      recentAppointments,
      recentPatients,
    ] = await Promise.all([
      db.patient.count({ where: { tenantId, ...notDeleted } }),
      db.patient.count({ where: { tenantId, ...notDeleted, createdAt: { gte: week } } }),
      db.patient.count({ where: { tenantId, ...notDeleted, createdAt: { gte: prevWeek, lt: week } } }),
      // What is on today's schedule; cancelled bookings are not.
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gte: todayStart, lte: todayEnd }, status: { not: "CANCELLED" } },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gte: todayStart, lte: todayEnd }, status: "COMPLETED" },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gt: now, lte: todayEnd }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gte: d(7), lte: addDays(todayEnd, -7, tz) }, status: { not: "CANCELLED" } },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gt: now }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gt: now, lte: addDays(todayEnd, 7, tz) }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
      }),
      // No-show rate: only appointments whose time has already passed.
      db.appointment.count({ where: { tenantId, ...notDeleted, startsAt: { gte: fortnight, lt: now }, status: held } }),
      db.appointment.count({ where: { tenantId, ...notDeleted, status: "NO_SHOW", startsAt: { gte: fortnight, lt: now } } }),
      db.appointment.count({ where: { tenantId, ...notDeleted, startsAt: { gte: prevFortnight, lt: fortnight }, status: held } }),
      db.appointment.count({ where: { tenantId, ...notDeleted, status: "NO_SHOW", startsAt: { gte: prevFortnight, lt: fortnight } } }),
      db.aiRun.count({ where: { tenantId, createdAt: { gte: week } } }),
      db.aiRun.count({ where: { tenantId, createdAt: { gte: prevWeek, lt: week } } }),
      db.consultation.count({
        where: { tenantId, status: { in: ["RECORDING", "TRANSCRIBING", "EXTRACTING", "PENDING_REVIEW"] } },
      }),
      db.consultation.count({ where: { tenantId, status: "PENDING_REVIEW" } }),
      db.visit.count({ where: { tenantId, createdAt: { gte: fortnight } } }),
      db.visit.count({ where: { tenantId, createdAt: { gte: prevFortnight, lt: fortnight } } }),
      db.appointment.findMany({
        where: { tenantId, ...notDeleted, startsAt: { gte: d(TREND_DAYS - 1), lte: todayEnd }, status: { not: "CANCELLED" } },
        select: { startsAt: true },
      }),
      db.patient.findMany({
        where: { tenantId, ...notDeleted, createdAt: { gte: weeksStart } },
        select: { createdAt: true },
      }),
    ]);

    return {
      patients,
      patientsNew7,
      patientsNewPrev7,
      appointmentsToday,
      appointmentsTodayDone,
      appointmentsTodayToCome,
      appointmentsSameDayLastWeek,
      upcoming,
      upcoming7,
      noShowRate: pastInWindow ? noShows / pastInWindow : 0,
      noShowRatePrev: pastInPrev ? noShowsPrev / pastInPrev : 0,
      aiInteractions,
      aiInteractionsPrev,
      activeConsultations,
      pendingReview,
      signedVisits14,
      signedVisitsPrev14,
      diagnoses: await topDiagnoses(tenantId),
      appointmentTrend: buildTrend(
        recentAppointments.map((a) => a.startsAt),
        todayStart,
        tz,
      ),
      newPatientsWeekly: buildWeekly(
        recentPatients.map((p) => p.createdAt),
        weeksStart,
      ),
    };
  } catch (err) {
    console.error("[analytics] overview failed", err);
    return ZERO;
  }
}

async function topDiagnoses(tenantId: string): Promise<{ label: string; count: number }[]> {
  const histories = await db.medicalHistory.findMany({
    where: { patient: { tenantId } },
    select: { diagnoses: true },
    take: 500,
  });
  const counts = new Map<string, number>();
  for (const h of histories) {
    const list = Array.isArray(h.diagnoses) ? (h.diagnoses as unknown[]) : [];
    for (const d of list) {
      const label = String(d).trim();
      if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

/** One bucket per local day, oldest first, ending with today. */
function buildTrend(dates: Date[], todayStart: Date, tz: string): { day: string; count: number }[] {
  const buckets = new Map<string, number>();
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    buckets.set(dateKeyInTz(addDays(todayStart, -i, tz), tz), 0);
  }
  for (const date of dates) {
    const key = dateKeyInTz(date, tz);
    const current = buckets.get(key);
    if (current !== undefined) buckets.set(key, current + 1);
  }
  return [...buckets.entries()].map(([day, count]) => ({ day, count }));
}

/** Counts per 7-day bucket from `start`, oldest first. */
function buildWeekly(dates: Date[], start: Date): number[] {
  const out = new Array<number>(WEEKS).fill(0);
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  for (const date of dates) {
    const i = Math.floor((date.getTime() - start.getTime()) / weekMs);
    if (i >= 0 && i < WEEKS) out[i] = (out[i] ?? 0) + 1;
  }
  return out;
}

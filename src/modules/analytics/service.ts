import { db, notDeleted } from "@/lib/db";
import { addDays, dateKeyInTz, endOfDayInTz, startOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";

/**
 * Analytics aggregations for the ClinicMind overview dashboard. All queries are
 * tenant-scoped and "today" / the 7-day window follow the clinic's timezone,
 * not the server's. Failures degrade to zeroed widgets rather than crashing
 * the dashboard (e.g. before the DB is migrated/seeded).
 */
export interface OverviewMetrics {
  patients: number;
  appointmentsToday: number;
  upcoming: number;
  noShowRate: number; // 0..1
  aiInteractions: number;
  activeConsultations: number;
  diagnoses: { label: string; count: number }[];
  appointmentTrend: { day: string; count: number }[];
}

const ZERO: OverviewMetrics = {
  patients: 0,
  appointmentsToday: 0,
  upcoming: 0,
  noShowRate: 0,
  aiInteractions: 0,
  activeConsultations: 0,
  diagnoses: [],
  appointmentTrend: [],
};

/** Days in the trend / no-show window, today included. */
const WINDOW_DAYS = 7;

export async function getOverview(tenantId: string): Promise<OverviewMetrics> {
  try {
    const tz = await getTenantTimezone(tenantId);
    const now = new Date();
    const todayStart = startOfDayInTz(now, tz);
    const todayEnd = endOfDayInTz(now, tz);
    // Seven local days ending today (midnight on the clinic's clock).
    const windowStart = addDays(todayStart, -(WINDOW_DAYS - 1), tz);

    const [
      patients,
      appointmentsToday,
      upcoming,
      pastInWindow,
      noShows,
      aiInteractions,
      activeConsultations,
      recentAppointments,
    ] = await Promise.all([
      db.patient.count({ where: { tenantId, ...notDeleted } }),
      // What is on today's schedule; cancelled bookings are not.
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gte: todayStart, lte: todayEnd }, status: { not: "CANCELLED" } },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, startsAt: { gt: now }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
      }),
      // No-show rate denominator: only appointments whose time has already
      // passed, and which were expected to happen (cancelled and waitlisted
      // bookings never held a slot).
      db.appointment.count({
        where: {
          tenantId,
          ...notDeleted,
          startsAt: { gte: windowStart, lt: now },
          status: { notIn: ["CANCELLED", "WAITLISTED"] },
        },
      }),
      db.appointment.count({
        where: { tenantId, ...notDeleted, status: "NO_SHOW", startsAt: { gte: windowStart, lt: now } },
      }),
      db.aiRun.count({ where: { tenantId, createdAt: { gte: windowStart } } }),
      db.consultation.count({
        where: { tenantId, status: { in: ["RECORDING", "TRANSCRIBING", "EXTRACTING", "PENDING_REVIEW"] } },
      }),
      db.appointment.findMany({
        where: { tenantId, ...notDeleted, startsAt: { gte: windowStart, lte: todayEnd } },
        select: { startsAt: true },
      }),
    ]);

    return {
      patients,
      appointmentsToday,
      upcoming,
      noShowRate: pastInWindow ? noShows / pastInWindow : 0,
      aiInteractions,
      activeConsultations,
      diagnoses: await topDiagnoses(tenantId),
      appointmentTrend: buildTrend(
        recentAppointments.map((a) => a.startsAt),
        todayStart,
        tz,
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
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    buckets.set(dateKeyInTz(addDays(todayStart, -i, tz), tz), 0);
  }
  for (const date of dates) {
    const key = dateKeyInTz(date, tz);
    const current = buckets.get(key);
    if (current !== undefined) buckets.set(key, current + 1);
  }
  return [...buckets.entries()].map(([day, count]) => ({ day, count }));
}

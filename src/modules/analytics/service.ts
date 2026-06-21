import { db, notDeleted } from "@/lib/db";

/**
 * Analytics aggregations for the ClinicMind overview dashboard. All queries are
 * tenant-scoped. Failures degrade to zeroed widgets rather than crashing the
 * dashboard (e.g. before the DB is migrated/seeded).
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

export async function getOverview(tenantId: string): Promise<OverviewMetrics> {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setHours(23, 59, 59, 999);
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [patients, appointmentsToday, upcoming, total, noShows, aiInteractions, activeConsultations, recentAppointments] =
      await Promise.all([
        db.patient.count({ where: { tenantId, ...notDeleted } }),
        db.appointment.count({
          where: { tenantId, ...notDeleted, startsAt: { gte: startOfDay, lte: endOfDay } },
        }),
        db.appointment.count({
          where: { tenantId, ...notDeleted, startsAt: { gt: new Date() }, status: { in: ["SCHEDULED", "CONFIRMED"] } },
        }),
        db.appointment.count({ where: { tenantId, ...notDeleted, startsAt: { gte: weekAgo } } }),
        db.appointment.count({ where: { tenantId, ...notDeleted, status: "NO_SHOW", startsAt: { gte: weekAgo } } }),
        db.aiRun.count({ where: { tenantId, createdAt: { gte: weekAgo } } }),
        db.consultation.count({
          where: { tenantId, status: { in: ["RECORDING", "TRANSCRIBING", "EXTRACTING", "PENDING_REVIEW"] } },
        }),
        db.appointment.findMany({
          where: { tenantId, ...notDeleted, startsAt: { gte: weekAgo } },
          select: { startsAt: true },
        }),
      ]);

    return {
      patients,
      appointmentsToday,
      upcoming,
      noShowRate: total ? noShows / total : 0,
      aiInteractions,
      activeConsultations,
      diagnoses: await topDiagnoses(tenantId),
      appointmentTrend: buildTrend(recentAppointments.map((a) => a.startsAt)),
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

function buildTrend(dates: Date[]): { day: string; count: number }[] {
  const buckets = new Map<string, number>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    buckets.set(d.toISOString().slice(0, 10), 0);
  }
  for (const date of dates) {
    const key = date.toISOString().slice(0, 10);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([day, count]) => ({ day, count }));
}

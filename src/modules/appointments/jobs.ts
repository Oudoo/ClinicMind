import type { Job } from "@/modules/jobs/types";
import { db, notDeleted } from "@/lib/db";
import { dateKeyInTz, formatTimeInTz } from "@/lib/time";
import { notify } from "@/modules/notifications/service";
import { getTenantTimezone } from "./service";
import { NO_SHOW_FLAG_AFTER_MINUTES } from "./transitions";
import { sendAppointmentReminders } from "./reminders";

/**
 * Background jobs of the appointments module. Registered in modules/jobs/registry.ts;
 * each job is idempotent and safe to run every minute.
 *
 * `appointments-late-flag` (every 5 minutes): for every active tenant, a
 * SCHEDULED or CONFIRMED appointment more than 20 minutes past its start with
 * no check-in gets exactly one NO_SHOW-kind WARNING ("<patient> has not
 * checked in") for reception and the appointment's doctor, so the desk can
 * call the patient or free the slot.
 *
 * The "flagged" stamp is `Appointment.lateFlaggedAt`. A row is flagged only
 * while it is null, and the job claims it with
 * `UPDATE … SET lateFlaggedAt = now WHERE id = … AND lateFlaggedAt IS NULL`
 * before notifying, so two overlapping runs (or two server instances) can
 * never notify twice.
 *
 * Only bookings that started within the last 24 hours are considered, so a
 * backlog of old, never-closed bookings does not flood the bell; at most 100
 * per tenant per run (the rest are picked up five minutes later).
 */

export const LATE_FLAG_JOB = "appointments-late-flag";
const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const BATCH = 100;

export interface LateFlagSummary {
  tenants: number;
  flagged: number;
}

export async function flagLateAppointments(now: Date = new Date()): Promise<LateFlagSummary> {
  const cutoff = new Date(now.getTime() - NO_SHOW_FLAG_AFTER_MINUTES * 60_000);
  const floor = new Date(now.getTime() - LOOKBACK_MS);
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true } });
  let flagged = 0;

  for (const tenant of tenants) {
    const rows = await db.appointment.findMany({
      where: {
        tenantId: tenant.id,
        ...notDeleted,
        status: { in: ["SCHEDULED", "CONFIRMED"] },
        checkedInAt: null,
        lateFlaggedAt: null,
        startsAt: { lt: cutoff, gte: floor },
      },
      orderBy: { startsAt: "asc" },
      take: BATCH,
      select: { id: true, startsAt: true, doctorId: true, room: true, patient: { select: { fullName: true } } },
    });
    if (!rows.length) continue;

    const tz = await getTenantTimezone(tenant.id);
    const doctorIds = [...new Set(rows.map((r) => r.doctorId).filter((id): id is string => Boolean(id)))];
    const doctors = doctorIds.length
      ? await db.user.findMany({ where: { tenantId: tenant.id, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } })
      : [];
    const doctorName = new Map(doctors.map((d) => [d.id, d.fullName ?? d.email]));

    for (const a of rows) {
      // Claim the row first: the stamp is what makes the flag fire once.
      const claimed = await db.appointment.updateMany({
        where: { id: a.id, tenantId: tenant.id, lateFlaggedAt: null },
        data: { lateFlaggedAt: now },
      });
      if (!claimed.count) continue;
      const minutes = Math.floor((now.getTime() - a.startsAt.getTime()) / 60_000);
      const who = a.doctorId ? doctorName.get(a.doctorId) : null;
      await notify(tenant.id, {
        kind: "NO_SHOW",
        level: "WARNING",
        title: `${a.patient.fullName} has not checked in`,
        body: `Booked ${formatTimeInTz(a.startsAt, tz)}${who ? ` with ${who}` : ""}${a.room ? ` · ${a.room}` : ""} · ${minutes} min past the start. Call the patient or mark the no-show.`,
        href: `/dashboard/appointments?date=${dateKeyInTz(a.startsAt, tz)}&view=day`,
        entity: "Appointment",
        entityId: a.id,
        roles: ["RECEPTIONIST"],
        // The booking's doctor, when the id is a user of this tenant (looked up above).
        userIds: a.doctorId && doctorName.has(a.doctorId) ? [a.doctorId] : [],
      }).catch((err) => console.error("[appointments-late-flag] notification failed", err));
      flagged += 1;
    }
  }
  return { tenants: tenants.length, flagged };
}

export const jobs: Job[] = [
  {
    name: LATE_FLAG_JOB,
    everyMinutes: 5,
    async run({ now }) {
      const result = await flagLateAppointments(now);
      return `${result.flagged} late appointment(s) flagged across ${result.tenants} tenant(s)`;
    },
  },
  {
    // The WhatsApp reminders 48 and 2 hours before, and tomorrow's unconfirmed visits flagged for a call (reminders.ts).
    name: "appointments-reminders",
    everyMinutes: 5,
    async run({ now }) {
      const r = await sendAppointmentReminders(now);
      return `${r.sent} reminder(s) sent, ${r.failed} failed, ${r.flagged} unconfirmed visit(s) flagged across ${r.tenants} tenant(s)`;
    },
  },
];

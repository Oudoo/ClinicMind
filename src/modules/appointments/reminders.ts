import type { AppointmentStatus } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { addDays, endOfDayInTz, formatDateInTz, formatTimeInTz, startOfDayInTz, zonedParts } from "@/lib/time";
import { sendPatientMessage } from "@/modules/messaging/outbound";
import { isQuiet, readReminderSettings, timeOn } from "@/modules/messaging/reminder-settings";
import { notify } from "@/modules/notifications/service";
import { patientWhen } from "./confirmation";
import { getTenantTimezone, getWorkingHours } from "./service";
import type { WorkingHours } from "./transitions";

/**
 * Appointment reminders on WhatsApp, in the patient's language:
 *  - 48 hours before (sent from 48 until 24 hours before, so quiet hours
 *    only delay it), and 2 hours before (from 2 hours until 30 minutes);
 *  - an unconfirmed booking is asked to confirm: "1" confirms it, "2" asks
 *    for another time and tells reception (the reply flow of
 *    appointments/confirmation.ts); a confirmed one is just reminded;
 *  - never in the quiet hours, never to a patient who said no to treatment
 *    reminders or has no number, never for a booking made minutes ago (6
 *    hours for the first, 2 for the second).
 * Each reminder is stamped on the booking before it goes (the claim), so it
 * goes once however many servers run the job. The day before, from the
 * clinic's chosen time (noon), the next open day's visits still unconfirmed
 * are flagged for reception to call, with one notification (on a Thursday,
 * Saturday's when the clinic is closed on Fridays).
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const LIVE: AppointmentStatus[] = ["SCHEDULED", "CONFIRMED"];

type Language = "ar" | "en";
const languageOf = (code: string | null | undefined): Language => (code === "en" ? "en" : "ar");
const firstNameOf = (fullName: string) => fullName.trim().split(/\s+/)[0] || fullName;

export type ReminderKind = "48h" | "2h";

export function reminderText(input: {
  kind: ReminderKind;
  language: Language;
  patientName: string;
  clinicName: string;
  startsAt: Date;
  timezone: string;
  doctorName: string | null;
  askToConfirm: boolean;
}): string {
  const first = firstNameOf(input.patientName);
  const ar = input.language === "ar";
  const doctor = input.doctorName ? (ar ? ` مع ${input.doctorName}` : ` with ${input.doctorName}`) : "";
  if (input.kind === "48h") {
    const when = patientWhen(input.startsAt, input.timezone, input.language);
    if (ar) {
      return `أهلاً ${first}، بنفكرك بميعادك في ${input.clinicName} يوم ${when}${doctor}. ${input.askToConfirm ? "ابعت 1 للتأكيد، أو 2 لو محتاج ميعاد تاني." : "في انتظارك."}`;
    }
    return `Hi ${first}, a reminder of your appointment at ${input.clinicName} on ${when}${doctor}. ${input.askToConfirm ? "Reply 1 to confirm, or 2 if you need another time." : "See you then."}`;
  }
  const time = new Intl.DateTimeFormat(ar ? "ar-EG-u-nu-latn" : "en-GB", { timeZone: input.timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(input.startsAt);
  if (ar) {
    return `أهلاً ${first}، في انتظارك النهارده الساعة ${time} في ${input.clinicName}${doctor}.${input.askToConfirm ? " ابعت 1 للتأكيد، أو 2 لو مش هتقدر تيجي." : ""}`;
  }
  return `Hi ${first}, see you today at ${time} at ${input.clinicName}${doctor}.${input.askToConfirm ? " Reply 1 to confirm, or 2 if you can't make it." : ""}`;
}

export interface ReminderSummary {
  tenants: number;
  sent: number;
  failed: number;
  flagged: number;
}

const BATCH = 100;

/** One pass: due reminders for every active clinic (or one), and the next open day's unconfirmed visits flagged. */
export async function sendAppointmentReminders(now: Date = new Date(), opts: { tenantId?: string } = {}): Promise<ReminderSummary> {
  const summary: ReminderSummary = { tenants: 0, sent: 0, failed: 0, flagged: 0 };
  const tenants = await db.tenant.findMany({ where: { status: "ACTIVE", deletedAt: null, ...(opts.tenantId ? { id: opts.tenantId } : {}) }, select: { id: true, name: true } });
  for (const tenant of tenants) {
    const settings = await readReminderSettings(tenant.id);
    const tz = await getTenantTimezone(tenant.id);
    summary.tenants += 1;
    if (settings.appointmentReminders && !isQuiet(now, tz, settings)) {
      for (const kind of ["48h", "2h"] as const) {
        const r = await remind(tenant, kind, tz, now);
        summary.sent += r.sent;
        summary.failed += r.failed;
      }
    }
    summary.flagged += await flagUnconfirmed(tenant.id, tz, settings.confirmCallsFrom, now);
  }
  return summary;
}

async function remind(tenant: { id: string; name: string }, kind: ReminderKind, tz: string, now: Date): Promise<{ sent: number; failed: number }> {
  const from = kind === "48h" ? new Date(now.getTime() + 24 * HOUR) : new Date(now.getTime() + 30 * MIN);
  const to = kind === "48h" ? new Date(now.getTime() + 48 * HOUR) : new Date(now.getTime() + 2 * HOUR);
  const bookedBefore = new Date(now.getTime() - (kind === "48h" ? 6 : 2) * HOUR);
  const rows = await db.appointment.findMany({
    where: {
      tenantId: tenant.id,
      ...notDeleted,
      status: { in: LIVE },
      startsAt: { gt: from, lte: to },
      createdAt: { lte: bookedBefore },
      ...(kind === "48h" ? { reminderSentAt: null } : { finalReminderSentAt: null }),
      patient: { deletedAt: null, reminderConsent: true, OR: [{ whatsapp: { not: null } }, { phone: { not: null } }] },
    },
    orderBy: { startsAt: "asc" },
    take: BATCH,
    select: { id: true, status: true, startsAt: true, doctorId: true, patientId: true, patient: { select: { fullName: true, language: true } } },
  });
  let sent = 0;
  let failed = 0;
  for (const a of rows) {
    // Claim first: the stamp is what makes each reminder go once.
    const claimed = await db.appointment.updateMany({
      where: { id: a.id, tenantId: tenant.id, status: { in: LIVE }, ...(kind === "48h" ? { reminderSentAt: null } : { finalReminderSentAt: null }) },
      data: kind === "48h" ? { reminderSentAt: now } : { finalReminderSentAt: now },
    });
    if (!claimed.count) continue;
    const askToConfirm = a.status === "SCHEDULED";
    const doctor = a.doctorId ? await db.user.findFirst({ where: { id: a.doctorId, tenantId: tenant.id }, select: { fullName: true } }) : null;
    const body = reminderText({
      kind,
      language: languageOf(a.patient.language),
      patientName: a.patient.fullName,
      clinicName: tenant.name,
      startsAt: a.startsAt,
      timezone: tz,
      doctorName: doctor?.fullName ?? null,
      askToConfirm,
    });
    try {
      const message = await sendPatientMessage(tenant.id, {
        patientId: a.patientId,
        body,
        channel: "WHATSAPP",
        templateKey: `appointment:reminder-${kind}`,
        author: "SYSTEM",
        meta: { appointmentId: a.id, kind: `reminder-${kind}` },
      });
      if (message.delivery === "FAILED") {
        failed += 1;
        continue;
      }
      sent += 1;
      // "1" or "2" now answers this booking (appointments/confirmation.ts).
      if (askToConfirm) {
        await db.appointment.updateMany({ where: { id: a.id, tenantId: tenant.id, status: "SCHEDULED" }, data: { confirmationRequestedAt: now } });
      }
    } catch (err) {
      failed += 1;
      console.error(`[appointments] the ${kind} reminder for appointment ${a.id} failed`, err);
    }
  }
  return { sent, failed };
}

/** The first day after today the clinic is open: the day its visits are called about today. */
export function nextOpenDay(now: Date, tz: string, hours: Pick<WorkingHours, "days">): Date {
  const today = startOfDayInTz(now, tz);
  for (let d = 1; d <= 7; d += 1) {
    const day = addDays(today, d, tz);
    if (hours.days.includes(zonedParts(day, tz).weekday)) return day;
  }
  return addDays(today, 1, tz);
}

/**
 * From `from` (a time of day) the day before: the next open day's bookings
 * still unconfirmed are flagged once, and reception gets one notification for
 * the ones flagged in this pass.
 */
async function flagUnconfirmed(tenantId: string, tz: string, from: string, now: Date): Promise<number> {
  if (now.getTime() < timeOn(now, tz, from).getTime()) return 0;
  const day = nextOpenDay(now, tz, await getWorkingHours(tenantId));
  const rows = await db.appointment.findMany({
    where: { tenantId, ...notDeleted, status: "SCHEDULED", confirmCallFlaggedAt: null, startsAt: { gte: day, lte: endOfDayInTz(day, tz) }, patient: { deletedAt: null } },
    orderBy: { startsAt: "asc" },
    take: 200,
    select: { id: true, startsAt: true, patient: { select: { fullName: true } } },
  });
  const flagged: typeof rows = [];
  for (const a of rows) {
    const claimed = await db.appointment.updateMany({ where: { id: a.id, tenantId, status: "SCHEDULED", confirmCallFlaggedAt: null }, data: { confirmCallFlaggedAt: now } });
    if (claimed.count) flagged.push(a);
  }
  if (flagged.length) {
    const names = flagged.slice(0, 3).map((a) => `${a.patient.fullName} ${formatTimeInTz(a.startsAt, tz)}`);
    const when = day.getTime() === addDays(startOfDayInTz(now, tz), 1, tz).getTime() ? "tomorrow" : `on ${formatDateInTz(day, tz, { weekday: "long" })}`;
    await notify(tenantId, {
      kind: "BOOKING_UNCONFIRMED",
      level: "WARNING",
      title: flagged.length === 1 ? `A visit ${when} is not confirmed` : `${flagged.length} visits ${when} are not confirmed`,
      body: `Call to confirm: ${names.join(", ")}${flagged.length > 3 ? ` and ${flagged.length - 3} more` : ""}.`,
      href: "/dashboard/recalls#confirm",
      roles: ["RECEPTIONIST"],
    }).catch((err: unknown) => console.error("[appointments] could not tell reception about the unconfirmed visits", err));
  }
  return flagged.length;
}

export interface ToConfirmRow {
  id: string;
  startsAt: string;
  status: AppointmentStatus;
  patient: { id: string; fullName: string; phone: string | null };
  doctorName: string | null;
  /** Why it is on the list: still unconfirmed for the next open day, or the patient asked for another time. */
  reason: "unconfirmed" | "reschedule";
}

/** Reception's calls about bookings: the next open day's visits still unconfirmed, and every patient who asked for another time. */
export async function listToConfirm(tenantId: string, now: Date = new Date()): Promise<ToConfirmRow[]> {
  const [tz, hours] = await Promise.all([getTenantTimezone(tenantId), getWorkingHours(tenantId)]);
  const day = nextOpenDay(now, tz, hours);
  const rows = await db.appointment.findMany({
    where: {
      tenantId,
      ...notDeleted,
      patient: { deletedAt: null },
      OR: [
        { status: "SCHEDULED", confirmCallFlaggedAt: { not: null }, startsAt: { gte: day, lte: endOfDayInTz(day, tz) } },
        { status: { in: LIVE }, rescheduleRequestedAt: { not: null }, startsAt: { gte: now } },
      ],
    },
    orderBy: { startsAt: "asc" },
    take: 100,
    select: { id: true, startsAt: true, status: true, doctorId: true, rescheduleRequestedAt: true, patient: { select: { id: true, fullName: true, phone: true, whatsapp: true } } },
  });
  const doctorIds = [...new Set(rows.map((r) => r.doctorId).filter((id): id is string => Boolean(id)))];
  const doctors = doctorIds.length ? await db.user.findMany({ where: { tenantId, id: { in: doctorIds } }, select: { id: true, fullName: true, email: true } }) : [];
  const name = new Map(doctors.map((d) => [d.id, d.fullName ?? d.email]));
  return rows.map((r) => ({
    id: r.id,
    startsAt: r.startsAt.toISOString(),
    status: r.status,
    patient: { id: r.patient.id, fullName: r.patient.fullName, phone: r.patient.whatsapp ?? r.patient.phone },
    doctorName: r.doctorId ? (name.get(r.doctorId) ?? null) : null,
    reason: r.rescheduleRequestedAt ? "reschedule" : "unconfirmed",
  }));
}

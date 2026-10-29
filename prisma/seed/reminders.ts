import type { ConversationStatus, Prisma } from "@prisma/client";
import type { SeedContext } from "./index";
import { makeRandom } from "./util";
import { addDays, endOfDayInTz, formatDateInTz, formatTimeInTz, startOfDayInTz } from "../../src/lib/time";
import { getTenantTimezone, getWorkingHours } from "../../src/modules/appointments/service";
import { nextOpenDay, reminderText, type ReminderKind } from "../../src/modules/appointments/reminders";
import { confirmationAckText, patientWhen } from "../../src/modules/appointments/confirmation";
import { consentAckText } from "../../src/modules/messaging/consent";
import { isQuiet, quietEndOn, readReminderSettings, timeOn } from "../../src/modules/messaging/reminder-settings";
import { AUTO_STEPS } from "../../src/modules/recalls/auto-messages";
import { recallForMessage, renderRecallMessage } from "../../src/modules/recalls/messages";

/**
 * What the clinic sent on its own over the last days, written as its jobs
 * would have sent it (they run every few minutes; the seed writes their
 * history once, then they carry on from today):
 *  - the consents: every patient answered at registration (WhatsApp
 *    reminders yes, offers and news yes for about a third: Mervat, not seen
 *    for 19 months, among them, Sameh, 13 months, not); Yara said no to
 *    WhatsApp reminders at the desk after her first PRP session, and one
 *    patient with a visit on the next open day sent STOP five days ago;
 *  - appointment reminders 48 and 2 hours before every visit of the last
 *    three days and the next two, in the patient's language, after the quiet
 *    hours; the patients whose visit is confirmed answered 1 the day after the
 *    first reminder, one patient answered 2 (on the desk's call list until it
 *    is moved), and from noon the next open day's unconfirmed visits are
 *    flagged for a call;
 *  - every recall still waiting got its automatic messages (14 days before
 *    the due day, on it, 7 days after) as each came, logged on the recall.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Every state a visit of the last days can be in now, cancelled aside. */
const VISIT_STATES = ["SCHEDULED", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "NO_SHOW"] as const;
/** A contact by the desk this recent holds the recall's automatic message (as recalls/auto-messages.ts does). */
const DESK_CONTACT_MS = 3 * DAY;

interface Thread {
  id: string;
  created: boolean;
  first: number;
  lastIn: number;
  lastOut: number;
  status?: ConversationStatus;
}

export async function seedReminders(ctx: SeedContext): Promise<void> {
  const { db, tenantId } = ctx;
  const now = new Date();
  const r = makeRandom(3_303);
  const [tz, settings, hours, tenant] = await Promise.all([
    getTenantTimezone(tenantId),
    readReminderSettings(tenantId),
    getWorkingHours(tenantId),
    db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
  ]);
  const desk = ctx.users.find((u) => u.role === "RECEPTIONIST") ?? ctx.users[0]!;
  const deskIds = ctx.users.filter((u) => u.role === "RECEPTIONIST").map((u) => u.id);
  const at = (offsetDays: number, hour: number) => {
    const d = ctx.calendarDay(offsetDays);
    return ctx.zoned(d.y, d.m, d.d, Math.floor(hour), Math.round((hour % 1) * 60));
  };
  /** The first moment from `t` an automatic message may go: `t`, or the end of the quiet hours it falls in. */
  const awake = (t: Date) => {
    if (!isQuiet(t, tz, settings)) return t;
    const end = quietEndOn(t, tz, settings);
    return end.getTime() > t.getTime() ? end : quietEndOn(t, tz, settings, 1);
  };
  /** A job's pass a few minutes after the moment it could first go. */
  const pass = (t: Date, upTo: number) => new Date(t.getTime() + r.between(0, upTo) * MIN + r.between(0, 59) * 1000);

  const patients = new Map(
    (
      await db.patient.findMany({
        where: { tenantId, deletedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, fullName: true, phone: true, whatsapp: true, language: true, createdAt: true },
      })
    ).map((p) => [p.id, p]),
  );
  const language = (id: string) => (patients.get(id)?.language === "en" ? "en" : "ar");
  const reachable = (id: string) => Boolean(patients.get(id)?.whatsapp || patients.get(id)?.phone);

  // ── The WhatsApp threads the messages go to ──────────────────────────────
  const threads = new Map<string, Thread>();
  async function threadOf(patientId: string, when: Date): Promise<Thread> {
    const known = threads.get(patientId);
    if (known) return known;
    const p = patients.get(patientId)!;
    const found = await db.conversation.findFirst({ where: { tenantId, patientId, channel: "WHATSAPP" }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    const id =
      found?.id ??
      (
        await db.conversation.create({
          data: { tenantId, patientId, channel: "WHATSAPP", contactName: p.fullName, contactPhone: p.whatsapp ?? p.phone, locale: p.language, status: "WAITING_ON_PATIENT", createdAt: when, updatedAt: when },
          select: { id: true },
        })
      ).id;
    const thread: Thread = { id, created: !found, first: when.getTime(), lastIn: 0, lastOut: 0 };
    threads.set(patientId, thread);
    return thread;
  }
  let messageCount = 0;
  async function say(patientId: string, when: Date, m: { inbound?: boolean; body: string; templateKey?: string; meta?: Prisma.InputJsonObject }) {
    const thread = await threadOf(patientId, when);
    const row = await db.message.create({
      data: {
        tenantId,
        conversationId: thread.id,
        direction: m.inbound ? "INBOUND" : "OUTBOUND",
        body: m.body,
        author: m.inbound ? "PATIENT" : "SYSTEM",
        delivery: m.inbound ? "DELIVERED" : "LOGGED",
        templateKey: m.templateKey ?? null,
        meta: m.meta,
        deliveredAt: m.inbound ? when : null,
        createdAt: when,
      },
      select: { id: true },
    });
    thread.first = Math.min(thread.first, when.getTime());
    if (m.inbound) thread.lastIn = Math.max(thread.lastIn, when.getTime());
    else thread.lastOut = Math.max(thread.lastOut, when.getTime());
    messageCount += 1;
    return { id: row.id, conversationId: thread.id };
  }
  const later = (t: Date, seconds: number) => new Date(t.getTime() + seconds * 1000);

  // ── Consents ─────────────────────────────────────────────────────────────
  // Both asked at registration: reminders yes (the default), offers and news yes for about a third.
  await db.$executeRaw`UPDATE "patients" SET "reminderConsentAt" = "createdAt", "marketingConsentAt" = "createdAt" WHERE "tenantId" = ${tenantId}`;
  const byName = (name: string) => [...patients.values()].find((p) => p.fullName === name);
  const offersYes = [...patients.values()].filter((p) => p.fullName === "Mervat Saad" || (p.fullName !== "Sameh Ragab" && r.chance(0.35))).map((p) => p.id);
  await db.patient.updateMany({ where: { tenantId, id: { in: offersYes } }, data: { marketingConsent: true } });
  /** When a patient stopped agreeing (none: still agrees). */
  const remindersOff = new Map<string, number>();
  const offersOff = new Map<string, number>();

  // Yara: no WhatsApp reminders, said at the desk after her first PRP session (she prefers a call).
  const yara = byName("Yara Khalil");
  if (yara) {
    const when = at(-20, 12.6);
    await db.patient.update({ where: { id: yara.id }, data: { reminderConsent: false, reminderConsentAt: when } });
    await db.auditLog.create({
      data: { tenantId, actorId: desk.id, actorEmail: desk.email, action: "patient.update", entity: "Patient", entityId: yara.id, patientId: yara.id, before: { reminderConsent: true }, after: { reminderConsent: false }, createdAt: when },
    });
    remindersOff.set(yara.id, when.getTime());
  }

  // STOP on WhatsApp five days ago, from the patient of the next open day's last visit.
  const nextDay = nextOpenDay(now, tz, hours);
  const nextDayVisits = await db.appointment.findMany({
    where: { tenantId, deletedAt: null, status: { in: ["SCHEDULED", "CONFIRMED"] }, startsAt: { gte: nextDay, lte: endOfDayInTz(nextDay, tz) } },
    orderBy: [{ startsAt: "desc" }, { id: "asc" }],
    select: { patientId: true },
  });
  const curated = new Set(["Yara Khalil", "Mervat Saad", "Sameh Ragab"]);
  const stopper = nextDayVisits.map((v) => patients.get(v.patientId)).find((p) => p && reachable(p.id) && !curated.has(p.fullName));
  if (stopper) {
    const when = at(-5, 19.7);
    const stop = await say(stopper.id, when, { inbound: true, body: "STOP" });
    await say(stopper.id, later(when, 2), { body: consentAckText("stop", stopper.language), templateKey: "consent:stopped", meta: { kind: "consent-ack" } });
    await db.patient.update({ where: { id: stopper.id }, data: { reminderConsent: false, reminderConsentAt: when, marketingConsent: false, marketingConsentAt: when } });
    await db.timelineEvent.create({ data: { tenantId, patientId: stopper.id, kind: "WHATSAPP_MESSAGE", title: "Asked on WhatsApp for no more reminders or offers", occurredAt: when } });
    await db.auditLog.create({
      data: {
        tenantId,
        action: "patient.consent.withdraw",
        entity: "Patient",
        entityId: stopper.id,
        patientId: stopper.id,
        after: { via: "whatsapp", messageId: stop.id, reminderConsent: false, marketingConsent: false },
        createdAt: when,
      },
    });
    remindersOff.set(stopper.id, when.getTime());
    offersOff.set(stopper.id, when.getTime());
  }
  const remindersOn = (id: string, t: Date) => t.getTime() < (remindersOff.get(id) ?? Infinity);
  const offersOn = (id: string, t: Date) => offersYes.includes(id) && t.getTime() < (offersOff.get(id) ?? Infinity);

  // ── Appointment reminders, 48 and 2 hours before ─────────────────────────
  const visits = await db.appointment.findMany({
    where: { tenantId, deletedAt: null, status: { in: [...VISIT_STATES] }, startsAt: { gte: new Date(now.getTime() - 3 * DAY), lte: new Date(now.getTime() + 48 * HOUR) } },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    select: { id: true, patientId: true, doctorId: true, status: true, startsAt: true, createdAt: true, confirmedAt: true },
  });
  const doctorName = new Map(ctx.users.map((u) => [u.id, u.fullName]));
  const asked: { id: string; patientId: string; startsAt: Date; askedAt: Date }[] = [];
  let reminders = 0;
  let confirmedByReply = 0;
  for (const v of visits) {
    if (!reachable(v.patientId)) continue;
    const p = patients.get(v.patientId)!;
    const lang = language(v.patientId);
    const text = (kind: ReminderKind, askToConfirm: boolean) =>
      reminderText({ kind, language: lang, patientName: p.fullName, clinicName: tenant.name, startsAt: v.startsAt, timezone: tz, doctorName: v.doctorId ? (doctorName.get(v.doctorId) ?? null) : null, askToConfirm });
    const confirmedBy = (t: Date) => Boolean(v.confirmedAt && v.confirmedAt.getTime() <= t.getTime());
    let reminderSentAt: Date | null = null;
    let finalReminderSentAt: Date | null = null;
    let askedAt: Date | null = null;
    let replied = false;

    // 48 hours before (once the booking is six hours old), after the quiet hours; not with less than a day to go.
    const t48 = pass(awake(new Date(Math.max(v.startsAt.getTime() - 48 * HOUR, v.createdAt.getTime() + 6 * HOUR))), 4);
    if (t48.getTime() < v.startsAt.getTime() - 24 * HOUR && t48.getTime() <= now.getTime() && remindersOn(v.patientId, t48)) {
      const ask = !confirmedBy(t48);
      await say(v.patientId, t48, { body: text("48h", ask), templateKey: "appointment:reminder-48h", meta: { appointmentId: v.id, kind: "reminder-48h" } });
      reminderSentAt = t48;
      reminders += 1;
      if (ask) askedAt = t48;
      // Confirmed within the day after it: the patient's 1, and the clinic's thanks.
      const answeredAt = v.confirmedAt;
      if (ask && answeredAt && answeredAt.getTime() - t48.getTime() < DAY && answeredAt.getTime() <= now.getTime()) {
        const one = await say(v.patientId, answeredAt, { inbound: true, body: lang === "en" ? r.pick(["1", "1", "Yes", "ok 👍"]) : r.pick(["1", "1", "تمام", "أيوه"]) });
        await say(v.patientId, later(answeredAt, 2), {
          body: confirmationAckText("confirm", { language: lang, patientName: p.fullName, startsAt: v.startsAt, timezone: tz }),
          templateKey: "appointment:confirmed-thanks",
          meta: { appointmentId: v.id, kind: "confirmation-ack" },
        });
        await db.timelineEvent.create({ data: { tenantId, patientId: v.patientId, kind: "APPOINTMENT", title: "Confirmed the appointment on WhatsApp", refId: v.id, occurredAt: answeredAt } });
        await db.auditLog.create({
          data: { tenantId, action: "appointment.confirm", entity: "Appointment", entityId: v.id, patientId: v.patientId, after: { via: "whatsapp", messageId: one.id, startsAt: v.startsAt.toISOString(), status: "CONFIRMED" }, createdAt: answeredAt },
        });
        askedAt = null;
        replied = true;
        confirmedByReply += 1;
      }
    }

    // 2 hours before (once the booking is two hours old), after the quiet hours, until half an hour before.
    const t2 = pass(awake(new Date(Math.max(v.startsAt.getTime() - 2 * HOUR, v.createdAt.getTime() + 2 * HOUR))), 4);
    if (t2.getTime() <= v.startsAt.getTime() - 30 * MIN && t2.getTime() <= now.getTime() && remindersOn(v.patientId, t2)) {
      const ask = !confirmedBy(t2) && !replied;
      await say(v.patientId, t2, { body: text("2h", ask), templateKey: "appointment:reminder-2h", meta: { appointmentId: v.id, kind: "reminder-2h" } });
      finalReminderSentAt = t2;
      reminders += 1;
      if (ask) askedAt = t2;
    }

    // Still unconfirmed and ahead: the latest reminder waits for the patient's 1 or 2.
    const waiting = askedAt && v.status === "SCHEDULED" && v.startsAt.getTime() > now.getTime() ? askedAt : null;
    if (reminderSentAt || finalReminderSentAt) {
      await db.appointment.update({ where: { id: v.id }, data: { reminderSentAt, finalReminderSentAt, ...(waiting ? { confirmationRequestedAt: waiting } : {}) } });
    }
    if (waiting) asked.push({ id: v.id, patientId: v.patientId, startsAt: v.startsAt, askedAt: waiting });
  }

  // One patient answered 2: on the desk's call list until the visit is moved (one before the next open day when there is one).
  const candidates = asked.filter((a) => a.startsAt.getTime() > now.getTime() + HOUR && a.askedAt.getTime() < now.getTime() - 30 * MIN);
  const two = candidates.find((a) => a.startsAt.getTime() < nextDay.getTime()) ?? candidates[0];
  if (two) {
    const p = patients.get(two.patientId)!;
    const lang = language(two.patientId);
    const when = new Date(Math.min(two.askedAt.getTime() + 35 * MIN, now.getTime() - 5 * MIN));
    const answer = await say(two.patientId, when, { inbound: true, body: lang === "en" ? "2" : "٢" });
    await say(two.patientId, later(when, 2), {
      body: confirmationAckText("decline", { language: lang, patientName: p.fullName, startsAt: two.startsAt, timezone: tz }),
      templateKey: "appointment:another-time-thanks",
      meta: { appointmentId: two.id, kind: "confirmation-ack" },
    });
    await db.appointment.update({ where: { id: two.id }, data: { confirmationRequestedAt: null, rescheduleRequestedAt: when } });
    await db.timelineEvent.create({ data: { tenantId, patientId: two.patientId, kind: "APPOINTMENT", title: "Asked for another appointment time on WhatsApp", refId: two.id, occurredAt: when } });
    await db.auditLog.create({
      data: { tenantId, action: "appointment.confirmation.decline", entity: "Appointment", entityId: two.id, patientId: two.patientId, after: { via: "whatsapp", messageId: answer.id, startsAt: two.startsAt.toISOString() }, createdAt: when },
    });
    if (deskIds.length) {
      await db.notification.createMany({
        data: deskIds.map((userId) => ({
          tenantId,
          userId,
          kind: "MESSAGE_INBOUND" as const,
          title: `${p.fullName} asks for another time`,
          body: `${patientWhen(two.startsAt, tz, "en")}: answered 2 to the reminder. Call to rebook (Recalls → Contact today).`,
          href: `/dashboard/conversations?c=${answer.conversationId}`,
          entity: "Conversation",
          entityId: answer.conversationId,
          createdAt: when,
        })),
      });
    }
    threads.get(two.patientId)!.status = "WAITING_ON_CLINIC";
  }

  // From noon (the clinic's chosen time) the day before: the next open day's unconfirmed visits, flagged for a call.
  let flagged = 0;
  const callsFrom = timeOn(now, tz, settings.confirmCallsFrom);
  if (now.getTime() >= callsFrom.getTime()) {
    const flagAt = new Date(Math.min(pass(callsFrom, 4).getTime(), now.getTime()));
    const rows = await db.appointment.findMany({
      where: { tenantId, deletedAt: null, status: "SCHEDULED", confirmCallFlaggedAt: null, startsAt: { gte: nextDay, lte: endOfDayInTz(nextDay, tz) } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      select: { id: true, startsAt: true, patient: { select: { fullName: true } } },
    });
    if (rows.length) {
      await db.appointment.updateMany({ where: { tenantId, id: { in: rows.map((x) => x.id) } }, data: { confirmCallFlaggedAt: flagAt } });
      const names = rows.slice(0, 3).map((x) => `${x.patient.fullName} ${formatTimeInTz(x.startsAt, tz)}`);
      const when = nextDay.getTime() === addDays(startOfDayInTz(now, tz), 1, tz).getTime() ? "tomorrow" : `on ${formatDateInTz(nextDay, tz, { weekday: "long" })}`;
      await db.notification.createMany({
        data: deskIds.map((userId) => ({
          tenantId,
          userId,
          kind: "BOOKING_UNCONFIRMED" as const,
          level: "WARNING" as const,
          title: rows.length === 1 ? `A visit ${when} is not confirmed` : `${rows.length} visits ${when} are not confirmed`,
          body: `Call to confirm: ${names.join(", ")}${rows.length > 3 ? ` and ${rows.length - 3} more` : ""}.`,
          href: "/dashboard/recalls#confirm",
          createdAt: flagAt,
        })),
      });
      flagged = rows.length;
    }
  }

  // ── Each waiting recall's automatic messages, as each came ───────────────
  const waitingRecalls = await db.recall.findMany({
    where: { tenantId, status: { in: ["OPEN", "CONTACTED"] }, channel: "WHATSAPP", dueAt: { lte: endOfDayInTz(addDays(now, 14, tz), tz) } },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, dueAt: true, createdAt: true, patientId: true },
  });
  const deskContacts = await db.recallActivity.findMany({
    where: { tenantId, recallId: { in: waitingRecalls.map((x) => x.id) }, kind: { in: ["CALL", "MESSAGE"] }, byId: { not: null } },
    select: { recallId: true, at: true },
  });
  let recallMessages = 0;
  let recallsMessaged = 0;
  for (const rc of waitingRecalls) {
    if (!reachable(rc.patientId)) continue;
    const agrees = (t: Date) => (rc.kind === "LAPSED" ? offersOn(rc.patientId, t) : remindersOn(rc.patientId, t));
    const times = AUTO_STEPS.map((s) => quietEndOn(rc.dueAt, tz, settings, s.days).getTime());
    const contacts = deskContacts.filter((c) => c.recallId === rc.id).map((c) => c.at.getTime());
    const firstPass = awake(rc.createdAt).getTime();
    // The job's passes that matter: the first after the recall was made, each step's time, and the end of a hold after a desk contact.
    const moments = [...new Set([firstPass, ...times, ...contacts.map((c) => awake(new Date(c + DESK_CONTACT_MS + MIN)).getTime())])].filter((t) => t >= firstPass && t <= now.getTime()).sort((x, y) => x - y);
    let step = 0;
    for (const moment of moments) {
      const due = AUTO_STEPS.filter((s, i) => s.step > step && times[i]! <= moment).pop();
      if (!due || contacts.some((c) => c <= moment && c > moment - DESK_CONTACT_MS)) continue;
      const when = moment === firstPass && moment === rc.createdAt.getTime() ? new Date(moment) : new Date(Math.min(pass(new Date(moment), 9).getTime(), now.getTime()));
      if (!agrees(when)) continue;
      const loaded = await recallForMessage(tenantId, rc.id);
      if (!loaded) break;
      const rendered = await renderRecallMessage(tenantId, loaded, { timezone: tz, now: when });
      if (!rendered.body || rendered.unfilled.length) break;
      const m = await say(rc.patientId, when, { body: rendered.body, templateKey: rendered.templateKey, meta: { recallId: rc.id, kind: "recall", step: due.step } });
      await db.recallActivity.create({ data: { tenantId, recallId: rc.id, kind: "MESSAGE", outcome: "LOGGED", note: `Automatic, ${due.label}: ${rendered.body}`.slice(0, 1000), messageId: m.id, at: when } });
      step = due.step;
      recallMessages += 1;
    }
    if (step) {
      await db.recall.update({ where: { id: rc.id }, data: { autoStep: step } });
      recallsMessaged += 1;
    }
  }

  // ── The threads: first and last messages, and whose turn it is ───────────
  for (const t of threads.values()) {
    const c = await db.conversation.findUniqueOrThrow({ where: { id: t.id }, select: { updatedAt: true, lastInboundAt: true, lastOutboundAt: true } });
    const latest = (current: Date | null, ms: number) => (ms && (!current || ms > current.getTime()) ? new Date(ms) : current);
    await db.conversation.update({
      where: { id: t.id },
      data: {
        ...(t.created ? { createdAt: new Date(t.first) } : {}),
        lastInboundAt: latest(c.lastInboundAt, t.lastIn),
        lastOutboundAt: latest(c.lastOutboundAt, t.lastOut),
        updatedAt: latest(c.updatedAt, Math.max(t.lastIn, t.lastOut)) ?? c.updatedAt,
        ...(t.status ? { status: t.status } : {}),
      },
    });
  }

  console.log(
    `     reminders: ${reminders} appointment reminders (${confirmedByReply} answered 1${two ? ", one 2" : ""}), ${flagged} visit(s) of ${formatDateInTz(nextDay, tz, { weekday: "long" })} flagged for a call; ${recallMessages} automatic recall messages to ${recallsMessaged} recalls; offers and news yes from ${offersYes.length} patients${stopper ? `, STOP from ${stopper.fullName}` : ""}; ${messageCount} messages.`,
  );
}

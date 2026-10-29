/**
 * What the clinic sends on its own (Phase 3C/3D), over the real services,
 * route handlers and the test database: appointment reminders 48 and 2 hours
 * before (in the patient's language, once each, never in the quiet hours,
 * never to a patient who said no, never for a booking made minutes ago), the
 * patient's 1 or 2 to a reminder, tomorrow's unconfirmed visits flagged for a
 * call; a recall's automatic messages (14 days before, on the due day and 7
 * days after: the latest step due, once, only while it waits, with the
 * consent its kind needs); STOP and START on WhatsApp, the consents on the
 * patient's record, the owner's settings; and the desk's list for the
 * recalls no message will reach.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppointmentStatus, Prisma } from "@prisma/client";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db, withoutScope } from "@/lib/db";
import { addDays, endOfDayInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { DEFAULT_REMINDER_SETTINGS, isQuiet, normalizeReminderSettings, quietEndOn, saveReminderSettings, type ReminderSettings } from "@/modules/messaging/reminder-settings";
import { consentAckText, readConsentReply } from "@/modules/messaging/consent";
import { signBody } from "@/modules/messaging/provider";
import { listToConfirm, reminderText, sendAppointmentReminders } from "@/modules/appointments/reminders";
import { patientWhen } from "@/modules/appointments/confirmation";
import { sendRecallMessages } from "@/modules/recalls/auto-messages";
import { GET as getSettingsRoute, PUT as putSettingsRoute } from "@/app/api/messaging/reminders/route";
import { PATCH as patchPatientRoute } from "@/app/api/patients/[id]/route";
import { PATCH as patchAppointmentRoute } from "@/app/api/appointments/[id]/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { POST as inboundRoute } from "@/app/api/integrations/messaging/inbound/[tenantSlug]/route";
import { POST as secretRoute } from "@/app/api/messaging/integration/secret/route";
import { GET as recallsRoute } from "@/app/api/recalls/route";
import { POST as recallActionRoute } from "@/app/api/recalls/[id]/actions/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** `hour`:`minute` on the clinic clock that day. */
const cairo = (year: number, month: number, day: number, hour = 0, minute = 0) => zonedTimeToUtc({ year, month, day, hour, minute }, TZ);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => ({ status: res.status, json: await res.json() });

describe("quiet hours, the reminders' wording and the patient's STOP", () => {
  it("quiet from 21:00 until 10:00 the next morning, or within one day", () => {
    const s = DEFAULT_REMINDER_SETTINGS;
    expect(isQuiet(cairo(2028, 1, 10, 20, 59), TZ, s)).toBe(false);
    expect(isQuiet(cairo(2028, 1, 10, 21), TZ, s)).toBe(true);
    expect(isQuiet(cairo(2028, 1, 11, 3), TZ, s)).toBe(true);
    expect(isQuiet(cairo(2028, 1, 11, 9, 59), TZ, s)).toBe(true);
    expect(isQuiet(cairo(2028, 1, 11, 10), TZ, s)).toBe(false);
    const lunch = { quietStart: "13:00", quietEnd: "15:00" };
    expect(isQuiet(cairo(2028, 1, 11, 14), TZ, lunch)).toBe(true);
    expect(isQuiet(cairo(2028, 1, 11, 15), TZ, lunch)).toBe(false);
    expect(isQuiet(cairo(2028, 1, 11, 22), TZ, lunch)).toBe(false);
    // When an automatic message of a day (days before or after another) may go: the end of that day's quiet hours.
    expect(quietEndOn(cairo(2028, 3, 6), TZ, s, -14)).toEqual(cairo(2028, 2, 21, 10));
    expect(quietEndOn(cairo(2028, 3, 6), TZ, s, 7)).toEqual(cairo(2028, 3, 13, 10));
  });

  it("whatever is stored is repaired field by field over the defaults", () => {
    expect(normalizeReminderSettings(null)).toEqual(DEFAULT_REMINDER_SETTINGS);
    expect(normalizeReminderSettings({ quietStart: "25:00", quietEnd: "21:00", appointmentReminders: "no", recallMessages: false, confirmCallsFrom: "13:30" })).toEqual({
      quietStart: "21:00",
      quietEnd: "10:00",
      appointmentReminders: true,
      recallMessages: false,
      confirmCallsFrom: "13:30",
    });
  });

  it("words each reminder in the patient's language; only an unconfirmed booking is asked to confirm", () => {
    const base = { patientName: "Mona Adel", clinicName: "Aura", startsAt: cairo(2028, 1, 12, 11), timezone: TZ, doctorName: "Dr. Omar Fahmy" };
    expect(reminderText({ ...base, kind: "48h", language: "en", askToConfirm: true })).toBe(
      "Hi Mona, a reminder of your appointment at Aura on Wednesday 12 January at 11:00 am with Dr. Omar Fahmy. Reply 1 to confirm, or 2 if you need another time.",
    );
    expect(reminderText({ ...base, kind: "48h", language: "en", askToConfirm: false, doctorName: null })).toBe("Hi Mona, a reminder of your appointment at Aura on Wednesday 12 January at 11:00 am. See you then.");
    expect(reminderText({ ...base, kind: "2h", language: "en", askToConfirm: false })).toBe("Hi Mona, see you today at 11:00 am at Aura with Dr. Omar Fahmy.");
    const ar = { ...base, patientName: "هالة منصور", clinicName: "أورا", language: "ar" as const };
    expect(reminderText({ ...ar, kind: "2h", askToConfirm: true })).toBe("أهلاً هالة، في انتظارك النهارده الساعة 11:00 ص في أورا مع Dr. Omar Fahmy. ابعت 1 للتأكيد، أو 2 لو مش هتقدر تيجي.");
    expect(reminderText({ ...ar, kind: "48h", askToConfirm: false, doctorName: null })).toBe("أهلاً هالة، بنفكرك بميعادك في أورا يوم الأربعاء 12 يناير الساعة 11:00 ص. في انتظارك.");
  });

  it("reads a patient's STOP or START, and nothing longer", () => {
    for (const stop of ["STOP", "stop", " Stop! ", "Unsubscribe", "إلغاء", "وقف", "كفاية"]) expect(readConsentReply(stop), stop).toBe("stop");
    for (const start of ["START", "start", "ابدأ"]) expect(readConsentReply(start), start).toBe("start");
    for (const other of ["", "1", "please stop", "stop the offers", "stopping", "تمام"]) expect(readConsentReply(other), other).toBeNull();
    expect(consentAckText("stop", "en")).toMatch(/^Done: you won't get reminders or offers from us/);
    expect(consentAckText("start", "ar")).toMatch(/^تمام، هترجع توصلك تذكيرات/);
  });
});

describe.skipIf(!dbTestsEnabled)("reminders, recall messages and consents", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let slug: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let receptionId: string;
  let doctorId: string;
  let secret: string;
  /** Patients by first name (`other` belongs to the second clinic). */
  const p = {} as Record<"mona" | "hala" | "nour" | "sameh" | "karim" | "sara" | "laila" | "other", string>;
  let keys = 0;

  /** A booking straight in the table; booked a month before unless said (reminders skip one made minutes ago). */
  async function book(patientId: string, startsAt: Date, opts: { status?: AppointmentStatus; createdAt?: Date; doctor?: boolean; tenantId?: string } = {}) {
    const status = opts.status ?? "SCHEDULED";
    return db.appointment.create({
      data: {
        tenantId: opts.tenantId ?? a,
        patientId,
        doctorId: opts.doctor ? doctorId : null,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * MIN),
        status,
        confirmedAt: status === "CONFIRMED" ? new Date() : null,
        statusChangedAt: new Date(),
        createdAt: opts.createdAt ?? new Date(startsAt.getTime() - 30 * 24 * HOUR),
      },
    });
  }

  /** A recall straight in the table: a review, open, on WhatsApp, unless said. */
  async function recall(patientId: string, dueAt: Date, extra: Partial<Prisma.RecallUncheckedCreateInput> = {}) {
    keys += 1;
    return db.recall.create({
      data: { tenantId: a, patientId, kind: "REVIEW", label: "Review", dueAt, windowEndAt: endOfDayInTz(addDays(dueAt, 14, TZ), TZ), dedupeKey: `test:${keys}`, ...extra },
    });
  }

  const appointment = (id: string) => db.appointment.findUniqueOrThrow({ where: { id } });
  const recallRow = (id: string) => db.recall.findUniqueOrThrow({ where: { id } });
  const messagesOf = (patientId: string) => db.message.findMany({ where: { tenantId: a, conversation: { patientId } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const inboundNotices = () => db.notification.findMany({ where: { tenantId: a, kind: "MESSAGE_INBOUND" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const saveSettings = (patch: Partial<ReminderSettings> = {}) => saveReminderSettings(a, { ...DEFAULT_REMINDER_SETTINGS, ...patch });
  /** Real-time tests: a one-hour quiet window twelve hours from now, so whenever they run the clinic is awake. */
  const awake = () => {
    const hour = zonedParts(new Date(), TZ).hour;
    const at = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
    return saveSettings({ quietStart: at(hour + 12), quietEnd: at(hour + 13) });
  };
  /** The first day from `n` days ahead the clinic is open (not a Friday), at `hour` on its clock. */
  const openDay = (n: number, hour: number) => {
    for (let d = n; d < n + 7; d += 1) {
      const day = zonedParts(addDays(new Date(), d, TZ), TZ);
      if (day.weekday !== 5) return cairo(day.year, day.month, day.day, hour);
    }
    throw new Error("no open day");
  };

  /** The patient's WhatsApp message, through the signed webhook, as the provider calls it. */
  async function reply(from: string, body: string) {
    const raw = JSON.stringify({ from, body, externalId: `wamid.${Math.random().toString(36).slice(2)}` });
    const res = await withoutScope(() =>
      inboundRoute(
        new Request(`http://localhost:3000/api/integrations/messaging/inbound/${slug}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-clinicmind-signature": signBody(secret, raw) },
          body: raw,
        }),
        { params: Promise.resolve({ tenantSlug: slug }) },
      ),
    );
    expect(res.status).toBe(200);
  }

  beforeAll(async () => {
    slug = `remind-${Date.now().toString(36)}`;
    const tenant = await createTenant({ slug, name: "Aura Derma & Hair Clinic" });
    const other = await createTenant({ slug: `remind-b-${Date.now().toString(36)}` });
    a = tenant.id;
    b = other.id;
    created.push(a, b);
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Omar Fahmy" });
    receptionId = reception.id;
    doctorId = doctor.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    const patient = async (fullName: string, phone: string | null, extra: Record<string, unknown> = {}) =>
      (await db.patient.create({ data: { tenantId: a, fullName, phone, whatsapp: phone, language: "en", ...extra } })).id;
    p.mona = await patient("Mona Adel", "+201005550101");
    p.hala = await patient("Hala Mansour", "+201005550102", { language: "ar" });
    p.nour = await patient("Nour Samir", null);
    p.sameh = await patient("Sameh Ragab", "+201005550104", { reminderConsent: false });
    p.karim = await patient("Karim Lotfy", "+201005550105", { marketingConsent: true });
    p.sara = await patient("Sara Nabil", "+201005550106", { marketingConsent: true });
    p.laila = await patient("Laila Fawzy", "+201005550107");
    p.other = (await db.patient.create({ data: { tenantId: b, fullName: "Other Clinic", phone: "+201005550199", whatsapp: "+201005550199" } })).id;
    // The webhook secret makes a (manual, unconnected) WhatsApp channel: messages are logged, replies come in signed.
    const res = await secretRoute(request("/api/messaging/integration/secret", { method: "POST", cookie: ownerCookie }));
    expect(res.status).toBe(200);
    secret = (await res.json()).secret;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("48 and 2 hours before, in the patient's language, once each; only an unconfirmed booking is asked to confirm", async () => {
    const now = cairo(2028, 1, 10, 12); // Monday noon
    const ask = await book(p.mona, cairo(2028, 1, 12, 11), { doctor: true });
    const confirmed = await book(p.hala, cairo(2028, 1, 12, 10, 30), { status: "CONFIRMED", doctor: true });
    const today = await book(p.hala, cairo(2028, 1, 10, 13, 30), { doctor: true });
    const tomorrow = await book(p.hala, cairo(2028, 1, 11, 11), { doctor: true });
    const beyond = await book(p.mona, cairo(2028, 1, 12, 12, 30)); // 48½ hours ahead
    const fresh = await book(p.mona, cairo(2028, 1, 12, 9), { createdAt: new Date(now.getTime() - HOUR) });
    const cancelled = await book(p.mona, cairo(2028, 1, 12, 9, 30), { status: "CANCELLED" });
    const saidNo = await book(p.sameh, cairo(2028, 1, 12, 11));
    const noNumber = await book(p.nour, cairo(2028, 1, 12, 11));
    const elsewhere = await book(p.other, cairo(2028, 1, 12, 11), { tenantId: b });

    expect(await sendAppointmentReminders(now, { tenantId: a })).toEqual({ tenants: 1, sent: 3, failed: 0, flagged: 1 });
    const toMona = await messagesOf(p.mona);
    expect(toMona).toHaveLength(1);
    expect(toMona[0]).toMatchObject({ direction: "OUTBOUND", author: "SYSTEM", templateKey: "appointment:reminder-48h", delivery: "LOGGED" });
    expect(toMona[0]!.body).toBe(
      "Hi Mona, a reminder of your appointment at Aura Derma & Hair Clinic on Wednesday 12 January at 11:00 am with Dr. Omar Fahmy. Reply 1 to confirm, or 2 if you need another time.",
    );
    const toHala = new Map((await messagesOf(p.hala)).map((m) => [m.templateKey, m.body]));
    expect([...toHala.keys()].sort()).toEqual(["appointment:reminder-2h", "appointment:reminder-48h"]);
    expect(toHala.get("appointment:reminder-48h")).toBe("أهلاً Hala، بنفكرك بميعادك في Aura Derma & Hair Clinic يوم الأربعاء 12 يناير الساعة 10:30 ص مع Dr. Omar Fahmy. في انتظارك.");
    expect(toHala.get("appointment:reminder-2h")).toBe("أهلاً Hala، في انتظارك النهارده الساعة 1:30 م في Aura Derma & Hair Clinic مع Dr. Omar Fahmy. ابعت 1 للتأكيد، أو 2 لو مش هتقدر تيجي.");

    // Stamped before they went; an unconfirmed booking now waits for the patient's 1 or 2.
    expect(await appointment(ask.id)).toMatchObject({ reminderSentAt: now, finalReminderSentAt: null, confirmationRequestedAt: now });
    expect(await appointment(confirmed.id)).toMatchObject({ reminderSentAt: now, confirmationRequestedAt: null });
    expect(await appointment(today.id)).toMatchObject({ reminderSentAt: null, finalReminderSentAt: now, confirmationRequestedAt: now });
    for (const untouched of [tomorrow, beyond, fresh, cancelled, saidNo, noNumber, elsewhere]) {
      expect(await appointment(untouched.id), untouched.id).toMatchObject({ reminderSentAt: null, finalReminderSentAt: null });
    }
    expect(await messagesOf(p.sameh)).toHaveLength(0);
    expect(await messagesOf(p.nour)).toHaveLength(0);

    // Tomorrow's visit, still unconfirmed at noon: flagged once, reception told once, on the call list.
    expect((await appointment(tomorrow.id)).confirmCallFlaggedAt).toEqual(now);
    const flags = await db.notification.findMany({ where: { tenantId: a, kind: "BOOKING_UNCONFIRMED" } });
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ userId: receptionId, level: "WARNING", title: "A visit tomorrow is not confirmed", body: "Call to confirm: Hala Mansour 11:00.", href: "/dashboard/recalls#confirm" });
    expect(await listToConfirm(a, now)).toEqual([
      { id: tomorrow.id, startsAt: tomorrow.startsAt.toISOString(), status: "SCHEDULED", patient: { id: p.hala, fullName: "Hala Mansour", phone: "+201005550102" }, doctorName: "Dr. Omar Fahmy", reason: "unconfirmed" },
    ]);

    // However often the job runs, each goes once.
    expect(await sendAppointmentReminders(new Date(now.getTime() + 5 * MIN), { tenantId: a })).toEqual({ tenants: 1, sent: 0, failed: 0, flagged: 0 });
    expect(await db.message.count({ where: { tenantId: a } })).toBe(3);
    expect(await db.notification.count({ where: { tenantId: a, kind: "BOOKING_UNCONFIRMED" } })).toBe(1);

    // Six hours on, the booking made an hour before is old enough, and the one 48½ hours ahead has come into the window.
    const evening = new Date(now.getTime() + 6 * HOUR);
    expect(await sendAppointmentReminders(evening, { tenantId: a })).toEqual({ tenants: 1, sent: 2, failed: 0, flagged: 0 });
    expect(await appointment(fresh.id)).toMatchObject({ reminderSentAt: evening, confirmationRequestedAt: evening });
    expect(await appointment(beyond.id)).toMatchObject({ reminderSentAt: evening });
    expect(await appointment(saidNo.id)).toMatchObject({ reminderSentAt: null });
    expect(await appointment(elsewhere.id)).toMatchObject({ reminderSentAt: null });
  });

  it("never in the quiet hours: a reminder due at night goes in the morning; switched off, none goes", async () => {
    const visit = await book(p.mona, cairo(2028, 1, 19, 20)); // Wednesday evening
    expect(await sendAppointmentReminders(cairo(2028, 1, 17, 22), { tenantId: a })).toEqual({ tenants: 1, sent: 0, failed: 0, flagged: 0 });
    const morning = cairo(2028, 1, 18, 10);
    expect(await sendAppointmentReminders(morning, { tenantId: a })).toEqual({ tenants: 1, sent: 1, failed: 0, flagged: 0 });
    expect(await appointment(visit.id)).toMatchObject({ reminderSentAt: morning, confirmCallFlaggedAt: null });

    // From noon the day before, still unconfirmed: on the call list.
    const noon = cairo(2028, 1, 18, 12);
    expect(await sendAppointmentReminders(noon, { tenantId: a })).toEqual({ tenants: 1, sent: 0, failed: 0, flagged: 1 });
    expect((await listToConfirm(a, noon)).map((r) => [r.id, r.reason])).toEqual([[visit.id, "unconfirmed"]]);

    await saveSettings({ appointmentReminders: false });
    try {
      const later = await book(p.hala, cairo(2028, 1, 20, 11));
      expect(await sendAppointmentReminders(cairo(2028, 1, 18, 12, 30), { tenantId: a })).toEqual({ tenants: 1, sent: 0, failed: 0, flagged: 0 });
      expect(await appointment(later.id)).toMatchObject({ reminderSentAt: null });
    } finally {
      await saveSettings();
    }
  });

  it("on a Thursday the calls are about Saturday's visits: the clinic is closed on Fridays", async () => {
    const thursday = cairo(2028, 1, 27, 12);
    const saturday = await book(p.mona, cairo(2028, 1, 29, 11));
    expect(await sendAppointmentReminders(thursday, { tenantId: a })).toEqual({ tenants: 1, sent: 1, failed: 0, flagged: 1 });
    const [notice] = await db.notification.findMany({ where: { tenantId: a, kind: "BOOKING_UNCONFIRMED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1 });
    expect(notice).toMatchObject({ title: "A visit on Saturday is not confirmed", body: "Call to confirm: Mona Adel 11:00." });
    expect((await listToConfirm(a, thursday)).map((r) => [r.id, r.reason])).toEqual([[saturday.id, "unconfirmed"]]);
    // Friday, closed: nothing more to flag.
    expect(await sendAppointmentReminders(cairo(2028, 1, 28, 12), { tenantId: a })).toEqual({ tenants: 1, sent: 0, failed: 0, flagged: 0 });
  });

  it("the patient's 1 confirms the booking a reminder asked about; 2 asks for another time and puts it on the desk's list until it is moved", async () => {
    await awake();
    try {
      const first = await book(p.mona, new Date(Date.now() + 47 * HOUR));
      expect((await sendAppointmentReminders(new Date(), { tenantId: a })).sent).toBe(1);
      const notices = (await inboundNotices()).length;
      await reply("+201005550101", "1");
      expect(await appointment(first.id)).toMatchObject({ status: "CONFIRMED", confirmationRequestedAt: null, rescheduleRequestedAt: null });
      expect((await messagesOf(p.mona)).at(-1)).toMatchObject({ author: "SYSTEM", templateKey: "appointment:confirmed-thanks" });
      expect(await db.timelineEvent.count({ where: { tenantId: a, refId: first.id, title: "Confirmed the appointment on WhatsApp" } })).toBe(1);
      expect((await inboundNotices()).length).toBe(notices);

      const second = await book(p.hala, new Date(Date.now() + 46 * HOUR));
      expect((await sendAppointmentReminders(new Date(), { tenantId: a })).sent).toBe(1);
      await reply("+201005550102", "2");
      const asked = await appointment(second.id);
      expect(asked).toMatchObject({ status: "SCHEDULED", confirmationRequestedAt: null });
      expect(asked.rescheduleRequestedAt).toBeTruthy();
      const notice = (await inboundNotices()).pop()!;
      expect(notice).toMatchObject({ userId: receptionId, title: "Hala Mansour asks for another time" });
      expect(notice.body).toBe(`${patientWhen(asked.startsAt, TZ, "en")}: answered 2 to the reminder. Call to rebook (Recalls → Contact today).`);
      expect(await db.timelineEvent.count({ where: { tenantId: a, refId: second.id, title: "Asked for another appointment time on WhatsApp" } })).toBe(1);
      expect(await listToConfirm(a)).toContainEqual(expect.objectContaining({ id: second.id, reason: "reschedule" }));

      // The desk moves it: the request is answered, and the new time's reminders start again.
      const target = openDay(4, 11);
      const moved = await patchAppointmentRoute(
        request(`/api/appointments/${second.id}`, { method: "PATCH", cookie: receptionCookie, body: { startsAt: target.toISOString(), endsAt: new Date(target.getTime() + 30 * MIN).toISOString() } }),
        params(second.id),
      );
      expect(moved.status, JSON.stringify(await moved.clone().json())).toBe(200);
      expect(await appointment(second.id)).toMatchObject({ startsAt: target, rescheduleRequestedAt: null, reminderSentAt: null, finalReminderSentAt: null });
      expect((await listToConfirm(a)).map((r) => r.id)).not.toContain(second.id);

      // Or confirms it after a call: the request is answered too.
      const third = await book(p.mona, new Date(Date.now() + 45 * HOUR));
      expect((await sendAppointmentReminders(new Date(), { tenantId: a })).sent).toBe(1);
      await reply("+201005550101", "No");
      expect((await appointment(third.id)).rescheduleRequestedAt).toBeTruthy();
      const res = await transitionRoute(request(`/api/appointments/${third.id}/transition`, { method: "POST", cookie: receptionCookie, body: { status: "CONFIRMED" } }), params(third.id));
      expect(res.status).toBe(200);
      expect(await appointment(third.id)).toMatchObject({ status: "CONFIRMED", rescheduleRequestedAt: null });
      expect((await listToConfirm(a)).map((r) => r.id)).not.toContain(third.id);
    } finally {
      await saveSettings();
    }
  });

  it("STOP turns off reminders and offers, START turns reminders back on; anything longer goes to the inbox", async () => {
    const notices = (await inboundNotices()).length;
    await reply("+201005550106", "STOP");
    const stopped = await db.patient.findUniqueOrThrow({ where: { id: p.sara } });
    expect(stopped).toMatchObject({ reminderConsent: false, marketingConsent: false });
    expect(stopped.reminderConsentAt!.getTime()).toBeGreaterThan(Date.now() - MIN);
    expect(stopped.marketingConsentAt).toEqual(stopped.reminderConsentAt);
    expect((await messagesOf(p.sara)).at(-1)).toMatchObject({ direction: "OUTBOUND", author: "SYSTEM", templateKey: "consent:stopped", body: consentAckText("stop", "en") });
    expect(await db.timelineEvent.count({ where: { tenantId: a, patientId: p.sara, title: "Asked on WhatsApp for no more reminders or offers" } })).toBe(1);
    const withdrawn = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "patient.consent.withdraw", entityId: p.sara } });
    expect(withdrawn.after).toMatchObject({ via: "whatsapp", reminderConsent: false, marketingConsent: false });
    expect((await inboundNotices()).length).toBe(notices);

    // Said again (in Arabic): nothing changes and nothing more is said.
    const count = (await messagesOf(p.sara)).length;
    await reply("+201005550106", "وقف");
    expect((await messagesOf(p.sara)).length).toBe(count + 1);
    expect(await db.auditLog.count({ where: { tenantId: a, action: "patient.consent.withdraw", entityId: p.sara } })).toBe(1);

    // START brings treatment reminders back; offers stay off until the patient says yes to them.
    await reply("+201005550106", "Start");
    expect(await db.patient.findUniqueOrThrow({ where: { id: p.sara } })).toMatchObject({ reminderConsent: true, marketingConsent: false });
    expect((await messagesOf(p.sara)).at(-1)).toMatchObject({ templateKey: "consent:started", body: consentAckText("start", "en") });
    expect(await db.auditLog.count({ where: { tenantId: a, action: "patient.consent.give", entityId: p.sara } })).toBe(1);
    expect((await inboundNotices()).length).toBe(notices);

    await reply("+201005550106", "please stop sending offers");
    expect((await inboundNotices()).pop()!.title).toBe("New message from Sara Nabil");
    expect(await db.patient.findUniqueOrThrow({ where: { id: p.sara } })).toMatchObject({ reminderConsent: true, marketingConsent: false });
  });

  it("the desk records a patient's consents on their record: audited, with the time each changed", async () => {
    const patch = (body: Record<string, unknown>) => patchPatientRoute(request(`/api/patients/${p.laila}`, { method: "PATCH", cookie: receptionCookie, body }), params(p.laila)).then(json);
    expect(await db.patient.findUniqueOrThrow({ where: { id: p.laila } })).toMatchObject({ reminderConsent: true, marketingConsent: false, reminderConsentAt: null, marketingConsentAt: null });

    expect((await patch({ reminderConsent: false })).status).toBe(200);
    const off = await db.patient.findUniqueOrThrow({ where: { id: p.laila } });
    expect(off).toMatchObject({ reminderConsent: false, marketingConsentAt: null });
    expect(off.reminderConsentAt!.getTime()).toBeGreaterThan(Date.now() - MIN);
    const entry = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "patient.update", entityId: p.laila }, orderBy: { createdAt: "desc" } });
    expect(entry).toMatchObject({ actorId: receptionId, before: { reminderConsent: true }, after: { reminderConsent: false } });

    // Only a consent that changes is re-dated.
    expect((await patch({ marketingConsent: true, reminderConsent: false })).status).toBe(200);
    const yes = await db.patient.findUniqueOrThrow({ where: { id: p.laila } });
    expect(yes).toMatchObject({ reminderConsent: false, marketingConsent: true, reminderConsentAt: off.reminderConsentAt });
    expect(yes.marketingConsentAt).toBeTruthy();
    expect((await patch({ reminderConsent: "no" })).status).toBe(422);
  });

  it("the owner sets the quiet hours and what goes out; the desk reads them, never changes them", async () => {
    const get = () => getSettingsRoute(request("/api/messaging/reminders", { cookie: receptionCookie })).then(json);
    const put = (body: unknown, cookie = ownerCookie) => putSettingsRoute(request("/api/messaging/reminders", { method: "PUT", cookie, body })).then(json);
    expect(await get()).toEqual({ status: 200, json: { settings: DEFAULT_REMINDER_SETTINGS } });
    const wanted = { quietStart: "22:00", quietEnd: "09:30", appointmentReminders: true, recallMessages: false, confirmCallsFrom: "13:00" };
    expect((await put(wanted, receptionCookie)).status).toBe(403);
    expect(await put({ ...wanted, quietEnd: "22:00" })).toMatchObject({ status: 422, json: { error: "validation_error" } });
    expect((await put({ ...wanted, confirmCallsFrom: "1pm" })).status).toBe(422);
    try {
      expect(await put(wanted)).toEqual({ status: 200, json: { settings: wanted } });
      expect((await get()).json.settings).toEqual(wanted);
      const entry = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "tenant.reminders.update" }, orderBy: { createdAt: "desc" } });
      expect(entry.before).toEqual(DEFAULT_REMINDER_SETTINGS);
      expect(entry.after).toEqual(wanted);
    } finally {
      await saveSettings();
    }
  });

  it("a recall's automatic messages: 14 days before, on the due day and 7 days after, after the quiet hours, once each", async () => {
    const due = cairo(2028, 3, 6); // Monday 6 March
    const review = await recall(p.mona, due);
    const lapsedYes = await recall(p.karim, due, { kind: "LAPSED", label: "No visit for 12 months" });
    const lapsedNo = await recall(p.mona, due, { kind: "LAPSED", label: "No visit for 12 months" });
    const late = await recall(p.mona, cairo(2028, 2, 18), { kind: "NEXT_SESSION", stage: 2, label: "Session 2" });
    const broken = await recall(p.hala, due);
    const desk = await recall(p.karim, due, { status: "CONTACTED", attempts: 1, lastContactAt: cairo(2028, 2, 20, 11) });
    const callLater = await recall(p.mona, due, { nextContactAt: cairo(2028, 2, 23, 10) });
    const booked = await recall(p.mona, due, { status: "BOOKED", bookedAppointmentId: "booked-elsewhere", bookedAt: cairo(2028, 2, 1) });
    const snoozed = await recall(p.mona, due, { status: "SNOOZED", snoozedUntil: cairo(2028, 3, 20) });
    const voice = await recall(p.mona, due, { channel: "VOICE" });
    const saidNo = await recall(p.sameh, due);
    const noNumber = await recall(p.nour, due);
    const elsewhere = await recall(p.other, due, { tenantId: b });
    // The clinic's Arabic review text uses placeholders a recall cannot fill (its doctor; one no template should carry).
    await db.messageTemplate.create({ data: { tenantId: a, key: "recall-review-ar", name: "Recall: review (AR)", language: "ar", category: "recall", body: "أهلاً {{name}}، {{doctor}} مستنيك. {{voucher}}" } });

    const pass = (at: Date) => sendRecallMessages(at, { tenantId: a });
    const step = async (id: string) => (await recallRow(id)).autoStep;
    const logOf = (id: string) => db.recallActivity.findMany({ where: { recallId: id }, orderBy: [{ at: "asc" }, { id: "asc" }] });
    const sentFor = async (id: string) => {
      const ids = (await logOf(id)).map((x) => x.messageId).filter((m): m is string => Boolean(m));
      return db.message.findMany({ where: { id: { in: ids } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    };

    // Fourteen days before: not in the quiet hours, then once.
    expect(await pass(cairo(2028, 2, 21, 9, 59))).toEqual({ tenants: 0, sent: 0, failed: 0, skipped: 0 });
    const first = cairo(2028, 2, 21, 10);
    expect(await pass(first)).toEqual({ tenants: 1, sent: 3, failed: 0, skipped: 1 });
    expect(await recallRow(review.id)).toMatchObject({ autoStep: 1, status: "OPEN", attempts: 0, lastContactAt: null });
    const [message] = await sentFor(review.id);
    expect(message).toMatchObject({ direction: "OUTBOUND", author: "SYSTEM", authorId: null, templateKey: "recall-review-en", delivery: "LOGGED" });
    expect(message!.body).toBe("Hi Mona, this is Aura Derma & Hair Clinic. Your follow-up visit is due on Monday 6 March. Reply here with a day that suits you and we'll book you in.");
    expect(await logOf(review.id)).toEqual([
      expect.objectContaining({ kind: "MESSAGE", outcome: "LOGGED", byId: null, at: first, messageId: message!.id, note: `Automatic, 14 days before the due day: ${message!.body}` }),
    ]);
    // A patient not seen for a year is asked back only with a yes to offers and news.
    expect((await sentFor(lapsedYes.id)).map((m) => [m.templateKey, m.body])).toEqual([
      ["recall-lapsed-en", "Hi Karim, it's been a while since your last visit to Aura Derma & Hair Clinic. If you'd like a check-up, reply here and we'll find you a time."],
    ]);
    // A step missed is not sent late: only the latest step due.
    expect(await step(late.id)).toBe(2);
    expect((await logOf(late.id))[0]!.note).toBe("Automatic, on the due day: Hi Mona, this is Aura Derma & Hair Clinic. Your treatment session 2 is due now. Reply with a day and time that suit you and we'll book it.");
    // A template that cannot be filled: nothing goes, the recall says why.
    expect(await step(broken.id)).toBe(1);
    expect((await logOf(broken.id)).map((x) => [x.kind, x.note])).toEqual([["NOTE", 'The automatic message 14 days before the due day was not sent: the clinic\'s "recall-review-ar" template uses {{doctor}}, {{voucher}}.']]);
    expect(await db.message.count({ where: { tenantId: a, templateKey: "recall-review-ar" } })).toBe(0);
    // The desk's own plan comes first: a contact three days ago at most, or the day the patient asked to be called.
    expect(await step(desk.id)).toBe(0);
    expect(await step(callLater.id)).toBe(0);
    expect(await pass(cairo(2028, 2, 21, 10, 15))).toEqual({ tenants: 1, sent: 0, failed: 0, skipped: 0 });

    // The template is put right; the due day after the quiet hours.
    await db.messageTemplate.updateMany({ where: { tenantId: a, key: "recall-review-ar" }, data: { active: false } });
    expect(await pass(cairo(2028, 3, 6, 9))).toEqual({ tenants: 0, sent: 0, failed: 0, skipped: 0 });
    expect(await pass(cairo(2028, 3, 6, 10))).toEqual({ tenants: 1, sent: 6, failed: 0, skipped: 0 });
    for (const r of [review, lapsedYes, broken, desk, callLater]) expect(await step(r.id), r.label).toBe(2);
    expect(await step(late.id)).toBe(3);
    expect((await sentFor(review.id)).at(-1)!.body).toBe("Hi Mona, this is Aura Derma & Hair Clinic. Your follow-up visit is due now. Reply here with a day that suits you and we'll book you in.");
    expect((await sentFor(broken.id)).map((m) => [m.templateKey, m.body])).toEqual([["recall-review-ar", "أهلاً Hala، معاك Aura Derma & Hair Clinic. ميعاد زيارة المتابعة جه. ابعتلنا اليوم اللي يناسبك وإحنا نحجزلك 🌿"]]);
    expect((await logOf(desk.id)).at(-1)!.note).toMatch(/^Automatic, on the due day: Hi Karim/);
    // An automatic message is not the desk's attempt.
    expect(await recallRow(desk.id)).toMatchObject({ attempts: 1, lastContactAt: cairo(2028, 2, 20, 11) });

    // A week after the due day, the last; then nothing more.
    expect(await pass(cairo(2028, 3, 13, 10))).toEqual({ tenants: 1, sent: 5, failed: 0, skipped: 0 });
    for (const r of [review, lapsedYes, broken, desk, callLater, late]) expect(await step(r.id), r.label).toBe(3);
    expect((await logOf(review.id)).at(-1)!.note).toMatch(/^Automatic, 7 days after the due day: /);
    expect(await pass(cairo(2028, 3, 20, 10))).toEqual({ tenants: 1, sent: 0, failed: 0, skipped: 0 });

    // Never while booked or snoozed, on a phone-call recall, without the consent its kind needs, a number, or in another clinic.
    for (const r of [booked, snoozed, voice, saidNo, noNumber, lapsedNo, elsewhere]) expect(await step(r.id), r.label).toBe(0);
    expect(await db.recallActivity.count({ where: { recallId: { in: [booked, snoozed, voice, saidNo, noNumber, lapsedNo, elsewhere].map((r) => r.id) } } })).toBe(0);

    // Switched off by the owner: none goes; switched back on, the step due goes.
    const off = await recall(p.mona, cairo(2028, 4, 3));
    await saveSettings({ recallMessages: false });
    try {
      expect(await pass(cairo(2028, 3, 20, 10, 5))).toEqual({ tenants: 0, sent: 0, failed: 0, skipped: 0 });
    } finally {
      await saveSettings();
    }
    expect(await pass(cairo(2028, 3, 20, 10, 20))).toEqual({ tenants: 1, sent: 1, failed: 0, skipped: 0 });
    expect(await step(off.id)).toBe(1);
  });

  it("Contact today lists the recalls no message will reach, and the desk cannot WhatsApp a patient who said no", async () => {
    const inFive = startOfDayInTz(addDays(new Date(), 5, TZ), TZ);
    const saidNo = await recall(p.sameh, inFive);
    const lapsed = await recall(p.mona, inFive, { kind: "LAPSED", label: "No visit for 12 months" });
    const fine = await recall(p.hala, inFive);
    type Row = { id: string; hint: string | null; canMessage: boolean };
    const today = async () => (await recallsRoute(request("/api/recalls?tab=today", { cookie: receptionCookie })).then(json)).json.recalls as Row[];

    const list = await today();
    expect(list.find((r) => r.id === saidNo.id)).toMatchObject({ hint: "The patient said no to WhatsApp reminders: call.", canMessage: false });
    expect(list.find((r) => r.id === lapsed.id)).toMatchObject({ hint: "No consent to offers and news: call the patient.", canMessage: false });
    // Its own message will reach this one: it waits on the Due soon list.
    expect(list.map((r) => r.id)).not.toContain(fine.id);

    // With the recall messages off, every recall due soon is the desk's to contact.
    await saveSettings({ recallMessages: false });
    try {
      expect((await today()).find((r) => r.id === fine.id)).toMatchObject({ hint: "Automatic recall messages are off: contact the patient.", canMessage: true });
    } finally {
      await saveSettings();
    }

    const message = (id: string) => recallActionRoute(request(`/api/recalls/${id}/actions`, { method: "POST", cookie: receptionCookie, body: { action: "message" } }), params(id)).then(json);
    expect(await message(saidNo.id)).toMatchObject({ status: 409, json: { error: "no_consent", message: "The patient said no to WhatsApp reminders: call instead." } });
    expect(await message(lapsed.id)).toMatchObject({ status: 409, json: { error: "no_consent", message: "The patient has not agreed to offers and news on WhatsApp: call instead." } });
    expect(await db.recallActivity.count({ where: { recallId: { in: [saidNo.id, lapsed.id] } } })).toBe(0);
    expect((await message(fine.id)).status).toBe(200);
  });
});

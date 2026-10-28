/**
 * A moved appointment asks the patient to confirm the new time (Phase 1, time
 * and date rules): the WhatsApp request in the patient's language, the
 * "awaiting patient" state, and the reply through the inbound webhook (1
 * confirms, 2 asks for another time, anything else is for a person).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db, withoutScope } from "@/lib/db";
import { PATCH as patchRoute } from "@/app/api/appointments/[id]/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { POST as inboundRoute } from "@/app/api/integrations/messaging/inbound/[tenantSlug]/route";
import { POST as secretRoute } from "@/app/api/messaging/integration/secret/route";
import { __setMessagingFetchForTests, signBody } from "@/modules/messaging/provider";
import { confirmationRequestText, patientWhen, readConfirmationReply } from "@/modules/appointments/confirmation";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
/** 1 Mar 2027, a Monday; Cairo is UTC+2 then. */
const BASE = Date.UTC(2027, 2, 1);
/** `hour`:`minute` on the clinic clock, `day` days after BASE (never a Friday in these tests). */
const cairo = (day: number, hour: number, minute = 0) => new Date(BASE + day * DAY + (hour - 2) * 3_600_000 + minute * 60_000);
const span = (start: Date, minutes = 30) => ({ startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * 60_000).toISOString() });

describe("readConfirmationReply", () => {
  it("reads a clear yes or no in English and Egyptian Arabic, digits included", () => {
    for (const yes of ["1", " ١ ", "Yes!", "yes thanks", "OK 👍", "👍", "تمام", "تمام شكرا", "أيوه", "نعم", "أكيد", "Confirm"]) {
      expect(readConfirmationReply(yes), yes).toBe("confirm");
    }
    for (const no of ["2", "٢", "No", "no thanks", "لا", "لأ"]) expect(readConfirmationReply(no), no).toBe("decline");
  });

  it("leaves anything less clear to a person", () => {
    for (const unclear of ["", "1 2", "yes but can we do 6pm?", "Can I come at 7 instead?", "3", "maybe", "شكرا", `yes ${"really ".repeat(10)}`]) {
      expect(readConfirmationReply(unclear), unclear).toBeNull();
    }
  });

  it("words the request in the patient's language, on the clinic clock", () => {
    expect(patientWhen(cairo(0, 12), TZ, "en")).toBe("Monday 1 March at 12:00 pm");
    expect(patientWhen(cairo(0, 12), TZ, "ar")).toBe("الاثنين 1 مارس الساعة 12:00 م");
    const en = confirmationRequestText({ language: "en", patientName: "Mona Adel", clinicName: "Aura", startsAt: cairo(1, 14, 30), timezone: TZ, doctorName: "Dr. Omar Fahmy" });
    expect(en).toBe("Hi Mona, your appointment at Aura has moved to Tuesday 2 March at 2:30 pm with Dr. Omar Fahmy. Reply 1 to confirm, or 2 if this time doesn't suit you.");
    const ar = confirmationRequestText({ language: "ar", patientName: "هالة منصور", clinicName: "أورا", startsAt: cairo(1, 14, 30), timezone: TZ, doctorName: null });
    expect(ar).toBe("أهلاً هالة، ميعادك في أورا اتغير ليوم الثلاثاء 2 مارس الساعة 2:30 م. ابعت 1 للتأكيد، أو 2 لو الميعاد ده مش مناسب.");
  });
});

describe.skipIf(!dbTestsEnabled)("rescheduling asks the patient to confirm", () => {
  const created: string[] = [];
  let tenant: { id: string; slug: string };
  let receptionCookie: string;
  let doctor: { id: string };
  let secret: string;
  let mona: { id: string };
  let hala: { id: string };
  let noPhone: { id: string };
  let slotDay = 0;

  /** A booking of its own day (so moves never collide), status as given. */
  async function booking(patientId: string, status: "SCHEDULED" | "CONFIRMED" = "SCHEDULED") {
    slotDay += 1;
    if (new Date(BASE + slotDay * DAY).getUTCDay() === 5) slotDay += 1; // Fridays are closed
    const startsAt = cairo(slotDay, 11);
    return db.appointment.create({
      data: {
        tenantId: tenant.id,
        patientId,
        doctorId: doctor.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        status,
        confirmedAt: status === "CONFIRMED" ? new Date() : null,
        statusChangedAt: new Date(),
      },
    });
  }

  async function move(id: string, body: Record<string, unknown>) {
    const res = await patchRoute(request(`/api/appointments/${id}`, { method: "PATCH", cookie: receptionCookie, body }), { params: Promise.resolve({ id }) });
    return { status: res.status, json: await res.json() };
  }

  /** The same booking, an hour later the same day. */
  async function moveLater(appointment: { id: string; startsAt: Date }, extra: Record<string, unknown> = {}, hours = 1) {
    return move(appointment.id, { ...span(new Date(appointment.startsAt.getTime() + hours * 3_600_000)), ...extra });
  }

  /** The patient's WhatsApp reply, through the signed webhook, as the provider calls it. */
  async function reply(from: string, body: string) {
    const raw = JSON.stringify({ from, body, externalId: `wamid.${Math.random().toString(36).slice(2)}` });
    const res = await withoutScope(() =>
      inboundRoute(
        new Request(`http://localhost:3000/api/integrations/messaging/inbound/${tenant.slug}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-clinicmind-signature": signBody(secret, raw) },
          body: raw,
        }),
        { params: Promise.resolve({ tenantSlug: tenant.slug }) },
      ),
    );
    expect(res.status).toBe(200);
  }

  /** Earlier tests leave requests pending; a reply answers the latest one, so start from none. */
  const settle = (patientId: string) =>
    db.appointment.updateMany({ where: { tenantId: tenant.id, patientId, confirmationRequestedAt: { not: null } }, data: { confirmationRequestedAt: null } });
  const messagesOf = (patientId: string) =>
    db.message.findMany({ where: { tenantId: tenant.id, conversation: { patientId } }, orderBy: { createdAt: "asc" } });
  const inboundNotices = () => db.notification.findMany({ where: { tenantId: tenant.id, kind: "MESSAGE_INBOUND" }, orderBy: { createdAt: "asc" } });

  beforeAll(async () => {
    tenant = await createTenant({ slug: `confirm-${Date.now().toString(36)}`, name: "Aura Derma & Hair Clinic" });
    created.push(tenant.id);
    const owner = await createUser({ tenantId: tenant.id, role: "CLINIC_OWNER", fullName: "Owner" });
    const reception = await createUser({ tenantId: tenant.id, role: "RECEPTIONIST", fullName: "Desk" });
    doctor = await createUser({ tenantId: tenant.id, role: "DOCTOR", fullName: "Dr. Omar Fahmy" });
    receptionCookie = await sessionCookieFor(reception.id);
    mona = await db.patient.create({ data: { tenantId: tenant.id, fullName: "Mona Adel", phone: "+201005550001", whatsapp: "+201005550001", language: "en" } });
    hala = await db.patient.create({ data: { tenantId: tenant.id, fullName: "Hala Mansour", phone: "+201005550002", whatsapp: "+201005550002", language: "ar" } });
    noPhone = await db.patient.create({ data: { tenantId: tenant.id, fullName: "Nour Samir", language: "en" } });
    // The webhook secret makes a (manual, unconnected) WhatsApp channel: requests are logged, replies come in signed.
    const res = await secretRoute(request("/api/messaging/integration/secret", { method: "POST", cookie: await sessionCookieFor(owner.id) }));
    expect(res.status).toBe(200);
    secret = (await res.json()).secret;
  });

  afterEach(async () => {
    __setMessagingFetchForTests(null);
    delete process.env.WHATSAPP_CLOUD_TOKEN;
    const row = await db.channelIntegration.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const encrypted = (row.config as { secretEncrypted?: string }).secretEncrypted;
    await db.channelIntegration.update({ where: { id: row.id }, data: { provider: "manual", enabled: false, config: { secretEncrypted: encrypted } } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("a new time puts a confirmed booking back to unconfirmed and asks the patient, in their language", async () => {
    const appointment = await booking(mona.id, "CONFIRMED");
    const target = new Date(appointment.startsAt.getTime() + 3 * 3_600_000);
    const { status, json } = await move(appointment.id, span(target));
    expect(status).toBe(200);
    expect(json.appointment).toMatchObject({ status: "SCHEDULED", confirmedAt: null });
    expect(json.appointment.confirmationRequestedAt).toBeTruthy();
    expect(json.confirmation).toMatchObject({ requested: true, delivery: "LOGGED", reason: null });

    const [request1] = await messagesOf(mona.id);
    expect(request1).toMatchObject({ direction: "OUTBOUND", author: "SYSTEM", templateKey: "appointment:confirm-new-time", delivery: "LOGGED" });
    expect(request1!.body).toBe(
      `Hi Mona, your appointment at Aura Derma & Hair Clinic has moved to ${patientWhen(target, TZ, "en")} with Dr. Omar Fahmy. Reply 1 to confirm, or 2 if this time doesn't suit you.`,
    );
    const entry = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: "appointment.confirmation.request", entityId: appointment.id } });
    expect(entry).toMatchObject({ patientId: mona.id });
    expect(entry.after).toMatchObject({ delivery: "LOGGED", messageId: request1!.id });

    const arabic = await booking(hala.id);
    expect((await moveLater(arabic)).json.confirmation).toMatchObject({ requested: true });
    const [toHala] = await messagesOf(hala.id);
    expect(toHala!.body).toMatch(/^أهلاً Hala، ميعادك في Aura Derma & Hair Clinic اتغير ليوم .+ مع Dr\. Omar Fahmy\. ابعت 1 للتأكيد، أو 2 لو الميعاد ده مش مناسب\.$/);
  });

  it("sends through WhatsApp Cloud; outside the 24-hour window nothing is pending and the desk is told to call", async () => {
    const row = await db.channelIntegration.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const encrypted = (row.config as { secretEncrypted?: string }).secretEncrypted;
    await db.channelIntegration.update({ where: { id: row.id }, data: { provider: "whatsapp_cloud", enabled: true, config: { phoneNumberId: "109876543210", secretEncrypted: encrypted } } });
    process.env.WHATSAPP_CLOUD_TOKEN = "EAAG-test-token";
    const sent: unknown[] = [];
    __setMessagingFetchForTests(async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.REQ" }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const appointment = await booking(mona.id);
    const first = await moveLater(appointment);
    expect(first.json.confirmation).toMatchObject({ requested: true, delivery: "SENT" });
    expect(sent[0]).toMatchObject({ to: "201005550001", type: "text", text: { body: expect.stringContaining("Reply 1 to confirm") } });

    __setMessagingFetchForTests(async () => new Response(JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 }));
    const second = await moveLater(appointment, {}, 2);
    expect(second.json.confirmation).toMatchObject({ requested: false, delivery: "FAILED" });
    expect(second.json.confirmation.reason).toMatch(/24-hour window/);
    expect(second.json.appointment).toMatchObject({ status: "SCHEDULED", confirmationRequestedAt: null });
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).confirmationRequestedAt).toBeNull();
  });

  it("sends nothing without a mobile number, when the desk unticks it, or when the time did not change", async () => {
    const noNumber = await booking(noPhone.id);
    expect((await moveLater(noNumber)).json.confirmation).toEqual({ requested: false, delivery: null, reason: "no_phone", conversationId: null });
    expect(await messagesOf(noPhone.id)).toHaveLength(0);

    const agreed = await booking(mona.id, "CONFIRMED");
    const before = (await messagesOf(mona.id)).length;
    const unticked = await moveLater(agreed, { askPatientToConfirm: false });
    expect(unticked.json.confirmation).toBeNull();
    // Still a moved booking: unconfirmed until the desk confirms it.
    expect(unticked.json.appointment).toMatchObject({ status: "SCHEDULED", confirmationRequestedAt: null });

    const roomOnly = await move(agreed.id, { room: "Room 2" });
    expect(roomOnly.status).toBe(200);
    expect(roomOnly.json.confirmation).toBeNull();
    expect((await messagesOf(mona.id)).length).toBe(before);
  });

  it("the patient's 1 confirms the booking and thanks them; nobody is disturbed", async () => {
    await settle(mona.id);
    const appointment = await booking(mona.id);
    await moveLater(appointment);
    const notices = (await inboundNotices()).length;

    await reply("+201005550001", "1");
    const after = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(after).toMatchObject({ status: "CONFIRMED", confirmationRequestedAt: null });
    expect(after.confirmedAt).toBeTruthy();

    const messages = await messagesOf(mona.id);
    const thanks = messages[messages.length - 1]!;
    expect(thanks).toMatchObject({ direction: "OUTBOUND", author: "SYSTEM", templateKey: "appointment:confirmed-thanks" });
    expect(thanks.body).toBe(`Thank you, Mona. Your appointment on ${patientWhen(after.startsAt, TZ, "en")} is confirmed. See you then.`);
    const conversation = await db.conversation.findFirstOrThrow({ where: { tenantId: tenant.id, patientId: mona.id } });
    expect(conversation.status).not.toBe("WAITING_ON_CLINIC");
    expect((await inboundNotices()).length).toBe(notices);

    expect(await db.timelineEvent.count({ where: { tenantId: tenant.id, refId: appointment.id, title: "Confirmed the new appointment time on WhatsApp" } })).toBe(1);
    const entry = await db.auditLog.findFirstOrThrow({ where: { tenantId: tenant.id, action: "appointment.confirm", entityId: appointment.id } });
    expect(entry).toMatchObject({ patientId: mona.id, actorId: null });
    expect(entry.after).toMatchObject({ via: "whatsapp", status: "CONFIRMED" });

    // A second 1, with nothing pending, is an ordinary message.
    await reply("+201005550001", "1");
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe("CONFIRMED");
    expect((await inboundNotices()).length).toBe(notices + 1);
  });

  it("2 leaves it unconfirmed, thanks the patient and tells reception to find another time", async () => {
    await settle(hala.id);
    const appointment = await booking(hala.id);
    await moveLater(appointment);
    await reply("+201005550002", "٢");
    const after = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(after).toMatchObject({ status: "SCHEDULED", confirmedAt: null, confirmationRequestedAt: null });

    const messages = await messagesOf(hala.id);
    expect(messages[messages.length - 1]).toMatchObject({ author: "SYSTEM", templateKey: "appointment:another-time-thanks", body: "شكراً إنك بلغتنا يا Hala. فريقنا هيتواصل معاك قريب علشان نختار ميعاد يناسبك." });
    const notice = (await inboundNotices()).pop()!;
    expect(notice.title).toBe("Hala Mansour can't make the new time");
    expect(notice.body).toBe(`${patientWhen(after.startsAt, TZ, "en")}: asked for another time on WhatsApp`);
    expect((await db.conversation.findFirstOrThrow({ where: { tenantId: tenant.id, patientId: hala.id } })).status).toBe("WAITING_ON_CLINIC");
    expect(await db.auditLog.count({ where: { tenantId: tenant.id, action: "appointment.confirmation.decline", entityId: appointment.id } })).toBe(1);
  });

  it("anything else goes to the inbox and the request stays open; the latest move is the one confirmed", async () => {
    await settle(mona.id);
    const appointment = await booking(mona.id);
    await moveLater(appointment);
    await reply("+201005550001", "Can I come at 6 instead?");
    const pending = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(pending.status).toBe("SCHEDULED");
    expect(pending.confirmationRequestedAt).toBeTruthy();
    expect((await inboundNotices()).pop()!.title).toBe("New message from Mona Adel");

    // The desk moves it to six: the new request replaces the old one, and 1 confirms six.
    await moveLater(appointment, {}, 7);
    await reply("+201005550001", "ok thanks");
    const confirmed = await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.startsAt.getTime()).toBe(appointment.startsAt.getTime() + 7 * 3_600_000);
  });

  it("with two moved bookings waiting, each 1 confirms the one asked about last", async () => {
    await settle(mona.id);
    const earlier = await booking(mona.id);
    const later = await booking(mona.id);
    await moveLater(earlier);
    await moveLater(later);
    await reply("+201005550001", "1");
    expect((await db.appointment.findUniqueOrThrow({ where: { id: later.id } })).status).toBe("CONFIRMED");
    expect((await db.appointment.findUniqueOrThrow({ where: { id: earlier.id } })).status).toBe("SCHEDULED");
    await reply("+201005550001", "yes");
    expect((await db.appointment.findUniqueOrThrow({ where: { id: earlier.id } })).status).toBe("CONFIRMED");
  });

  it("confirming by hand settles the request: a late 2 changes nothing", async () => {
    await settle(hala.id);
    const appointment = await booking(hala.id);
    await moveLater(appointment);
    const res = await transitionRoute(
      request(`/api/appointments/${appointment.id}/transition`, { method: "POST", cookie: receptionCookie, body: { status: "CONFIRMED" } }),
      { params: Promise.resolve({ id: appointment.id }) },
    );
    expect(res.status).toBe(200);
    expect(await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).toMatchObject({ status: "CONFIRMED", confirmationRequestedAt: null });
    await reply("+201005550002", "2");
    expect((await db.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).status).toBe("CONFIRMED");
  });
});

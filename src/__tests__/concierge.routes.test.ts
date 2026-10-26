/**
 * Post-treatment concierge (Module 5) over the real route handlers and the
 * test database: enrolment when a procedure is signed (clinic-clock offsets,
 * idempotent, nothing without a protocol), the dispatcher (messages logged on
 * the patient's conversation, only token hashes stored, reminders, misses),
 * the public check-in link (validation, photos, a high-risk answer reaching
 * the rostered human within 15 minutes in hours and 30 out of hours, single
 * use), acknowledgement and resolution, the staff controls, protocol versions,
 * the roster settings, the board's KPIs, the jobs, RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Procedure } from "@prisma/client";
import { db } from "@/lib/db";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { enrolOnSignedProcedure } from "@/modules/concierge/service";
import { markMissedTasks, runConciergeDispatchForTenant, dispatchDueTasks } from "@/modules/concierge/dispatch";
import { notifyOverdueEscalations } from "@/modules/concierge/escalations";
import { checkInTokenHash } from "@/modules/concierge/tokens";
import { jobs } from "@/modules/concierge/jobs";
import { GET as boardRoute } from "@/app/api/concierge/board/route";
import { GET as enrolmentsRoute } from "@/app/api/concierge/enrolments/route";
import { GET as enrolmentRoute } from "@/app/api/concierge/enrolments/[id]/route";
import { POST as pauseRoute } from "@/app/api/concierge/enrolments/[id]/pause/route";
import { POST as resumeRoute } from "@/app/api/concierge/enrolments/[id]/resume/route";
import { POST as stopRoute } from "@/app/api/concierge/enrolments/[id]/stop/route";
import { POST as sendRoute } from "@/app/api/concierge/tasks/[id]/send/route";
import { POST as skipRoute } from "@/app/api/concierge/tasks/[id]/skip/route";
import { POST as answerRoute } from "@/app/api/concierge/tasks/[id]/answer/route";
import { GET as escalationsRoute } from "@/app/api/concierge/escalations/route";
import { POST as acknowledgeRoute } from "@/app/api/concierge/escalations/[id]/acknowledge/route";
import { POST as resolveRoute } from "@/app/api/concierge/escalations/[id]/resolve/route";
import { GET as protocolsRoute, POST as createProtocolRoute } from "@/app/api/concierge/protocols/route";
import { DELETE as discardProtocolRoute, GET as protocolRoute, PATCH as patchProtocolRoute } from "@/app/api/concierge/protocols/[id]/route";
import { POST as approveRoute } from "@/app/api/concierge/protocols/[id]/approve/route";
import { POST as retireRoute } from "@/app/api/concierge/protocols/[id]/retire/route";
import { GET as settingsRoute, PUT as putSettingsRoute } from "@/app/api/concierge/settings/route";
import { GET as fileRoute } from "@/app/api/concierge/files/[id]/route";
import { GET as publicGet, POST as publicPost } from "@/app/api/public/check-in/[token]/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";
import { zonedParts, zonedTimeToUtc } from "@/lib/time";

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const TZ = "Africa/Cairo";
/** An instant on the clinic clock, `days` from today (links expire a week after sending, so tests live near today). */
function cairoAt(days: number, hour: number, minute = 0): Date {
  const p = zonedParts(new Date(), TZ);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day + days, hour, minute }, TZ);
}
/** Procedures in the dispatch tests: two days ago at 11:00; the day-1 check-in goes out yesterday at 11:05. */
const PERFORMED = cairoAt(-2, 11);
const DAY1_SENT = cairoAt(-1, 11, 5);
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });
const MIN = 60_000;
const HOUR = 60 * MIN;
const ALWAYS_IN_HOURS = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "00:00" };
const NEVER_IN_HOURS = { days: [], start: "09:00", end: "21:00" };
// Enough of a JPEG for the magic-byte check; the bytes come back unchanged.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0xff, 0xd9]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe.skipIf(!dbTestsEnabled)("concierge", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let owner: { id: string };
  let doctor: { id: string };
  let nurse: { id: string };
  let receptionist: { id: string };
  let ownerB: { id: string };
  let ownerCookie: string;
  let doctorCookie: string;
  let nurseCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let treatments: Map<string, string>;
  let ip = 0;

  // ── helpers ────────────────────────────────────────────────────────────────

  async function patient(fullName: string, language = "en", tenantId = a) {
    return db.patient.create({ data: { tenantId, fullName, language, phone: `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}` } });
  }

  async function signed(patientId: string, treatmentKey: string, performedAt: Date, tenantId = a, status: "SIGNED" | "PLANNED" = "SIGNED"): Promise<Procedure> {
    const treatmentId = tenantId === a ? treatments.get(treatmentKey)! : (await db.treatment.findFirstOrThrow({ where: { tenantId, key: treatmentKey } })).id;
    return db.procedure.create({
      data: { tenantId, patientId, treatmentId, performedAt, price: 50_000, status, signedAt: status === "SIGNED" ? performedAt : null, doctorId: tenantId === a ? doctor.id : null },
    });
  }

  async function call(handler: (req: Request, ctx: never) => Promise<Response>, path: string, init: Parameters<typeof request>[1] = {}, id?: string) {
    const res = await handler(request(path, init), (id === undefined ? undefined : params(id)) as never);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { res, json, text };
  }

  /** The public endpoints, from a fresh client address each time (rate limits are per address). */
  async function publicCall(method: "GET" | "POST", token: string, body?: unknown) {
    ip += 1;
    const req = request(`/api/public/check-in/${token}`, { method, body, headers: { "x-forwarded-for": `10.9.${Math.floor(ip / 250)}.${ip % 250}` } });
    const res = method === "GET" ? await publicGet(req, tokenParams(token)) : await publicPost(req, tokenParams(token));
    const text = await res.text();
    return { res, json: text ? JSON.parse(text) : null, text };
  }

  async function settings(hours: object, cookie = ownerCookie) {
    return call(putSettingsRoute, "/api/concierge/settings", {
      method: "PUT",
      cookie,
      body: { hours, roster: { inHoursUserId: nurse.id, outOfHoursUserId: doctor.id, backupUserId: owner.id }, ackMinutes: { inHours: 15, outOfHours: 30 } },
    });
  }

  async function tasksOf(enrolmentId: string) {
    return db.conciergeTask.findMany({ where: { enrolmentId }, orderBy: { stepIndex: "asc" } });
  }

  async function lastMessageFor(taskId: string) {
    return db.message.findFirst({ where: { meta: { path: ["conciergeTaskId"], equals: taskId } }, orderBy: { createdAt: "desc" }, include: { conversation: true } });
  }

  function linkToken(body: string): string {
    const m = /\/check-in\/([A-Za-z0-9_-]{20,})/.exec(body);
    if (!m) throw new Error(`no link in: ${body}`);
    return m[1]!;
  }

  /** Enrol a hair transplant performed at `performedAt` and send what is due at `now`; returns the day-1 check-in's token. */
  async function sentDay1(name: string, performedAt = PERFORMED, now = DAY1_SENT) {
    const p = await patient(name);
    const proc = await signed(p.id, "hair-transplant", performedAt);
    const enrolment = (await enrolOnSignedProcedure(a, proc.id))!;
    await dispatchDueTasks(a, now);
    const [, day1] = await tasksOf(enrolment.enrolmentId);
    const message = await lastMessageFor(day1!.id);
    return { patient: p, procedure: proc, enrolmentId: enrolment.enrolmentId, task: day1!, token: linkToken(message!.body), message: message! };
  }

  beforeAll(async () => {
    resetRateLimits();
    const tenantA = await createTenant({ slug: `conc-a-${Date.now().toString(36)}`, name: "Aura Test Clinic" });
    const tenantB = await createTenant({ slug: `conc-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    await db.clinic.updateMany({ where: { tenantId: a }, data: { phone: "+20 2 2735 0101", timezone: "Africa/Cairo" } });
    await ensureDefaultTreatments(a);
    await ensureDefaultTreatments(b);
    treatments = new Map((await db.treatment.findMany({ where: { tenantId: a } })).map((t) => [t.key, t.id]));

    owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Dr. Owner" });
    doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. On Call" });
    nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse Heba" });
    receptionist = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk Youssef" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant" });
    ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    receptionCookie = await sessionCookieFor(receptionist.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
  });

  afterAll(async () => {
    resetRateLimits();
    await deleteTenants(created);
  });

  // ── Enrolment ──────────────────────────────────────────────────────────────

  describe("enrolment on a signed procedure", () => {
    it("plans every step at its clinic-clock offset, in the patient's language, once", async () => {
      const p = await patient("Omar Saeed", "ar");
      // 11:00 in Cairo on 27 Oct 2026 (summer time); the clocks go back on the 30th.
      const proc = await signed(p.id, "hair-transplant", new Date("2026-10-27T08:00:00Z"));
      const first = await enrolOnSignedProcedure(a, proc.id, { id: doctor.id, email: "doctor@test" });
      expect(first).toMatchObject({ tasks: 10 });

      const enrolment = await db.conciergeEnrolment.findUniqueOrThrow({ where: { id: first!.enrolmentId }, include: { protocol: true } });
      expect(enrolment).toMatchObject({ tenantId: a, patientId: p.id, procedureId: proc.id, status: "ACTIVE", language: "ar", channel: "WHATSAPP" });
      expect(enrolment.startedAt.toISOString()).toBe("2026-10-27T08:00:00.000Z");
      expect(enrolment.protocol).toMatchObject({ name: "Hair transplant aftercare", version: 1, status: "ACTIVE" });

      const tasks = await tasksOf(first!.enrolmentId);
      expect(tasks.map((t) => t.status)).toEqual(Array(10).fill("PENDING"));
      expect(tasks.map((t) => t.kind)).toEqual(["INSTRUCTION", "CHECK_IN", "CHECK_IN", "CHECK_IN", "PHOTO_REQUEST", "CHECK_IN", "CHECK_IN", "PHOTO_REQUEST", "PHOTO_REQUEST", "CHECK_IN"]);
      expect(tasks[0]!.dueAt.toISOString()).toBe("2026-10-27T12:00:00.000Z"); // + 4 h: 15:00 Cairo
      expect(tasks[1]!.dueAt.toISOString()).toBe("2026-10-28T08:00:00.000Z"); // day 1, 11:00 Cairo summer time
      expect(tasks[3]!.dueAt.toISOString()).toBe("2026-11-03T09:00:00.000Z"); // day 7, still 11:00 Cairo in winter time
      expect(tasks[9]!.dueAt.toISOString()).toBe("2027-10-27T08:00:00.000Z"); // month 12

      const timeline = await db.timelineEvent.findFirst({ where: { tenantId: a, refId: first!.enrolmentId } });
      expect(timeline).toMatchObject({ patientId: p.id, kind: "CHECK_IN", title: "Enrolled in Hair transplant aftercare v1" });
      expect(await db.auditLog.count({ where: { tenantId: a, action: "concierge.enrol", entityId: first!.enrolmentId } })).toBe(1);

      // Signing twice (a retry, a double click) keeps one enrolment and one set of tasks.
      const again = await enrolOnSignedProcedure(a, proc.id);
      expect(again).toEqual(first);
      expect(await db.conciergeTask.count({ where: { enrolmentId: first!.enrolmentId } })).toBe(10);
      expect(await db.conciergeEnrolment.count({ where: { procedureId: proc.id } })).toBe(1);
    });

    it("moves a check-in that would land before 10:00 to 10:00 on the clinic clock", async () => {
      const p = await patient("Early Bird");
      const proc = await signed(p.id, "botox-fillers", new Date("2026-11-15T05:30:00Z")); // 07:30 Cairo
      const enrolment = await enrolOnSignedProcedure(a, proc.id);
      const tasks = await tasksOf(enrolment!.enrolmentId);
      expect(tasks[0]!.dueAt.toISOString()).toBe("2026-11-15T06:30:00.000Z"); // instruction + 1 h: 08:30, kept
      expect(tasks[1]!.dueAt.toISOString()).toBe("2026-11-16T08:00:00.000Z"); // day 1: 07:30 → 10:00 Cairo
    });

    it("returns null for a planned procedure and for a treatment without a protocol", async () => {
      const p = await patient("No Protocol");
      const planned = await signed(p.id, "acne", new Date("2026-11-15T09:00:00Z"), a, "PLANNED");
      expect(await enrolOnSignedProcedure(a, planned.id)).toBeNull();
      const custom = await db.treatment.create({ data: { tenantId: a, key: "tattoo-removal", name: "Tattoo removal", category: "laser" } });
      const proc = await db.procedure.create({
        data: { tenantId: a, patientId: p.id, treatmentId: custom.id, performedAt: new Date(), price: 3000, status: "SIGNED", signedAt: new Date() },
      });
      expect(await enrolOnSignedProcedure(a, proc.id)).toBeNull();
      expect(await db.conciergeEnrolment.count({ where: { patientId: p.id } })).toBe(0);
      // Another tenant's procedure id is unknown here.
      const pb = await patient("Patient Of B", "ar", b);
      const foreign = await signed(pb.id, "acne", new Date(), b);
      await expect(enrolOnSignedProcedure(a, foreign.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  // ── Dispatch ───────────────────────────────────────────────────────────────

  describe("dispatch", () => {
    it("sends due steps on the patient's conversation (logged without a channel) and stores only the token's hash", async () => {
      const { patient: p, enrolmentId, task, token, message } = await sentDay1("Karim Nabil");
      const tasks = await tasksOf(enrolmentId);
      expect(tasks[0]).toMatchObject({ kind: "INSTRUCTION", status: "SENT", tokenHash: null, attempts: 1 });
      expect(task).toMatchObject({ kind: "CHECK_IN", status: "SENT", attempts: 1 });
      expect(task.sentAt?.toISOString()).toBe(DAY1_SENT.toISOString());
      expect(task.tokenHash).toBe(checkInTokenHash(token));
      expect(task.tokenHash).not.toContain(token);
      expect(JSON.stringify(await db.conciergeTask.findMany({ where: { enrolmentId } }))).not.toContain(token);

      expect(message).toMatchObject({ tenantId: a, direction: "OUTBOUND", author: "SYSTEM", delivery: "LOGGED", templateKey: "concierge:hair-transplant:1" });
      expect(message.conversation).toMatchObject({ patientId: p.id, channel: "WHATSAPP" });
      expect(message.body).toContain("Hi Karim,");
      expect(message.body).toContain(`http://localhost:3000/check-in/${token}`);
      expect(task.messageId).toBe(message.id);
      const instruction = await lastMessageFor(tasks[0]!.id);
      expect(instruction!.body).toContain("+20 2 2735 0101");
      expect(instruction!.conversationId).toBe(message.conversationId);

      // Running again in the same minute sends nothing more.
      expect(await dispatchDueTasks(a, DAY1_SENT)).toMatchObject({ sent: 0 });
      expect(await db.message.count({ where: { conversationId: message.conversationId } })).toBe(2);
    });

    it("reminds once after 24 hours with a fresh link, then marks the step missed and opens a watch escalation", async () => {
      const { enrolmentId, task, token } = await sentDay1("Reminder Patient");
      const remindAt = new Date(task.sentAt!.getTime() + 24 * HOUR + MIN);
      const summary = await runConciergeDispatchForTenant(a, remindAt);
      expect(summary.reminders).toBeGreaterThanOrEqual(1);
      const reminded = await db.conciergeTask.findUniqueOrThrow({ where: { id: task.id } });
      expect(reminded).toMatchObject({ status: "SENT", attempts: 2 });
      expect(reminded.sentAt?.toISOString()).toBe(task.sentAt?.toISOString());
      const reminder = await lastMessageFor(task.id);
      expect(reminder!.meta).toMatchObject({ reminder: true });
      expect(reminder!.body).toContain("reminder");
      const fresh = linkToken(reminder!.body);
      expect(fresh).not.toBe(token);
      expect((await publicCall("GET", token)).res.status).toBe(404); // the latest link is the valid one
      expect((await publicCall("GET", fresh)).res.status).toBe(200);

      // No second reminder.
      await runConciergeDispatchForTenant(a, new Date(remindAt.getTime() + 2 * HOUR));
      expect((await db.conciergeTask.findUniqueOrThrow({ where: { id: task.id } })).attempts).toBe(2);

      const missAt = new Date(task.sentAt!.getTime() + 48 * HOUR + MIN);
      const missed = await markMissedTasks(a, missAt);
      expect(missed.missed).toBeGreaterThanOrEqual(1);
      expect(await db.conciergeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "MISSED" });
      const watch = await db.escalation.findFirstOrThrow({ where: { tenantId: a, enrolmentId, level: "WATCH" } });
      expect(watch).toMatchObject({ status: "OPEN", summary: "No answer to the day 1 check-in", kind: "CONCIERGE" });
      expect(watch.details).toMatchObject({ reason: "missed", taskId: task.id, targetMinutes: 240 });

      // A late answer through the still-valid link closes the "no answer" escalation.
      const late = await publicCall("GET", fresh);
      expect(late.json).toMatchObject({ status: "MISSED", late: true });
      const answered = await publicCall("POST", fresh, { answers: { pain: 2, swelling: false, bleeding: false, fever: false } });
      expect(answered.res.status).toBe(200);
      expect(answered.json).toMatchObject({ ok: true, triage: "OK", callbackMinutes: null });
      expect(await db.escalation.findUniqueOrThrow({ where: { id: watch.id } })).toMatchObject({ status: "RESOLVED", resolution: "Patient answered the check-in late" });
    });

    it("skips steps more than a day late instead of flooding the patient", async () => {
      const p = await patient("Signed Late");
      const proc = await signed(p.id, "hair-transplant", cairoAt(-6, 11));
      const enrolment = await enrolOnSignedProcedure(a, proc.id);
      // Signed four days after the procedure: the instruction, day 1 and day 3 are long past.
      const result = await dispatchDueTasks(a, cairoAt(-2, 11, 30));
      expect(result.skipped).toBeGreaterThanOrEqual(3);
      const tasks = await tasksOf(enrolment!.enrolmentId);
      expect(tasks.slice(0, 3).map((t) => t.status)).toEqual(["SKIPPED", "SKIPPED", "SKIPPED"]);
      expect(tasks[0]!.lastError).toMatch(/more than a day late/);
      expect(tasks[3]!.status).toBe("PENDING");
    });
  });

  // ── The public link ────────────────────────────────────────────────────────

  describe("public check-in link", () => {
    it("shows the step without a session and never echoes the token", async () => {
      const { token } = await sentDay1("Public Viewer");
      const { res, json, text } = await publicCall("GET", token);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(json).toMatchObject({
        clinicName: "Aura Test Clinic",
        clinicPhone: "+20 2 2735 0101",
        language: "en",
        patientFirstName: "Public",
        status: "SENT",
        late: false,
        limits: { maxPhotos: 4 },
        step: { kind: "CHECK_IN", heading: { en: "Day 1 check-in", ar: "متابعة اليوم ١" }, satisfaction: false },
      });
      expect(json.step.questions.map((q: { key: string }) => q.key)).toEqual(["pain", "swelling", "bleeding", "fever"]);
      expect(text).not.toContain(token);
      expect((await publicCall("GET", "not-a-token")).res.status).toBe(404);
      expect((await publicCall("GET", "x".repeat(43))).res.status).toBe(404);
    });

    it("validates the answers against the step's questions (422 per question)", async () => {
      const { task, token } = await sentDay1("Validation Patient");
      const { res, json } = await publicCall("POST", token, { answers: { pain: 11, bleeding: "maybe" } });
      expect(res.status).toBe(422);
      expect(Object.keys(json.issues.fieldErrors).sort()).toEqual(["bleeding", "fever", "pain", "swelling"]);
      expect((await db.conciergeTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe("SENT");
      expect(await db.checkIn.count({ where: { taskId: task.id } })).toBe(0);
    });

    it("in hours, a high-risk answer reaches the in-hours nurse with a 15-minute target and a notification", async () => {
      expect((await settings(ALWAYS_IN_HOURS)).res.status).toBe(200);
      const { patient: p, enrolmentId, task, token } = await sentDay1("Mona Adel");
      const before = Date.now();
      const { res, json, text } = await publicCall("POST", token, {
        answers: { pain: "9", swelling: "yes", bleeding: "yes", fever: "no" },
        freeText: "It has been bleeding since the morning",
      });
      expect(res.status).toBe(200);
      expect(json).toEqual({ ok: true, triage: "HIGH_RISK", clinicPhone: "+20 2 2735 0101", callbackMinutes: 15, outOfHours: false });
      expect(text).not.toContain(token);

      const checkIn = await db.checkIn.findUniqueOrThrow({ where: { taskId: task.id } });
      expect(checkIn).toMatchObject({ tenantId: a, patientId: p.id, source: "link", triage: "HIGH_RISK", answers: { pain: 9, swelling: true, bleeding: true, fever: false } });
      expect((checkIn.flags as { key: string }[]).map((f) => f.key).sort()).toEqual(["bleeding", "freeText", "pain"]);
      expect(await db.conciergeTask.findUniqueOrThrow({ where: { id: task.id } })).toMatchObject({ status: "ANSWERED", tokenHash: null });

      const escalation = await db.escalation.findFirstOrThrow({ where: { tenantId: a, enrolmentId, level: "HIGH_RISK" } });
      expect(escalation).toMatchObject({ status: "OPEN", kind: "CONCIERGE", assignedToId: nurse.id, outOfHours: false, checkInId: checkIn.id, patientId: p.id });
      expect(escalation.dueAt.getTime() - escalation.createdAt.getTime()).toBe(15 * MIN);
      expect(escalation.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(escalation.details).toMatchObject({ targetMinutes: 15, backupUserId: owner.id, reason: "check-in" });
      expect(escalation.summary).toContain("pain 9/10");

      const notes = await db.notification.findMany({ where: { tenantId: a, entity: "Escalation", entityId: escalation.id } });
      expect(notes.map((n) => n.userId).sort()).toEqual([nurse.id, owner.id].sort());
      expect(notes[0]).toMatchObject({ kind: "ESCALATION", level: "CRITICAL", href: `/dashboard/concierge/enrolments/${enrolmentId}` });
      const timeline = await db.timelineEvent.findMany({ where: { tenantId: a, patientId: p.id }, orderBy: { occurredAt: "asc" } });
      expect(timeline.map((t) => t.title)).toEqual(expect.arrayContaining(["Day 1 check-in answered · High risk", "High risk escalation opened"]));
      expect(await db.auditLog.count({ where: { tenantId: a, action: "concierge.checkin.submit", entityId: checkIn.id } })).toBe(1);

      // The link is single-use: the same token is now a plain 404, for reading and for answering.
      const reuse = await publicCall("POST", token, { answers: { pain: 1, swelling: false, bleeding: false, fever: false } });
      expect(reuse.res.status).toBe(404);
      expect(reuse.json).toEqual({ error: "not_found" });
      expect((await publicCall("GET", token)).res.status).toBe(404);
      expect(await db.checkIn.count({ where: { taskId: task.id } })).toBe(1);
    });

    it("out of hours, the doctor on call gets it with a 30-minute target", async () => {
      expect((await settings(NEVER_IN_HOURS)).res.status).toBe(200);
      const { enrolmentId, token } = await sentDay1("Night Patient");
      const { json } = await publicCall("POST", token, { answers: { pain: 3, swelling: false, bleeding: false, fever: "yes" } });
      expect(json).toMatchObject({ triage: "HIGH_RISK", callbackMinutes: 30, outOfHours: true });
      const escalation = await db.escalation.findFirstOrThrow({ where: { tenantId: a, enrolmentId, level: "HIGH_RISK" } });
      expect(escalation).toMatchObject({ assignedToId: doctor.id, outOfHours: true });
      expect(escalation.dueAt.getTime() - escalation.createdAt.getTime()).toBe(30 * MIN);
      const notified = await db.notification.findMany({ where: { tenantId: a, entityId: escalation.id }, select: { userId: true } });
      expect(notified.map((n) => n.userId).sort()).toEqual([doctor.id, owner.id].sort());
      await settings(ALWAYS_IN_HOURS);
    });

    it("an answer inside the expected ranges is OK: no escalation, a note to the nurses", async () => {
      const { enrolmentId, task, token } = await sentDay1("Fine Patient");
      const { json } = await publicCall("POST", token, { answers: { pain: 2, swelling: true, bleeding: false, fever: false } });
      expect(json).toMatchObject({ triage: "OK", callbackMinutes: null });
      expect(await db.escalation.count({ where: { tenantId: a, enrolmentId } })).toBe(0);
      const checkIn = await db.checkIn.findUniqueOrThrow({ where: { taskId: task.id } });
      await new Promise((r) => setTimeout(r, 200)); // the nurses' note is fire-and-forget
      expect(await db.notification.count({ where: { tenantId: a, kind: "CHECK_IN_ANSWERED", entityId: checkIn.id, userId: nurse.id } })).toBe(1);
    });

    it("stores a photo request's photos, refuses an SVG, and serves the bytes tenant-scoped", async () => {
      const { enrolmentId } = await sentDay1("Photo Patient");
      const tasks = await tasksOf(enrolmentId);
      const photoTask = tasks.find((t) => t.kind === "PHOTO_REQUEST")!;
      expect((await call(sendRoute, `/api/concierge/tasks/${photoTask.id}/send`, { method: "POST", cookie: nurseCookie }, photoTask.id)).res.status).toBe(200);
      const token = linkToken((await lastMessageFor(photoTask.id))!.body);

      const view = await publicCall("GET", token);
      expect(view.json.step).toMatchObject({ kind: "PHOTO_REQUEST", photos: ["front", "top", "donor"] });
      const empty = await publicCall("POST", token, {});
      expect(empty.res.status).toBe(422);
      expect(empty.json.issues.fieldErrors.photos).toBeDefined();
      const svg = await publicCall("POST", token, { photos: [{ view: "front", type: "image/jpeg", data: SVG.toString("base64") }] });
      expect(svg.res.status).toBe(422);
      expect(svg.json.error).toBe("photo_type");
      expect(await db.fileBlob.count({ where: { tenantId: a } })).toBe(0);

      const ok = await publicCall("POST", token, { photos: [{ view: "front", name: "IMG_0001.jpg", type: "image/jpeg", data: `data:image/jpeg;base64,${JPEG.toString("base64")}` }] });
      expect(ok.res.status).toBe(200);
      const checkIn = await db.checkIn.findUniqueOrThrow({ where: { taskId: photoTask.id } });
      expect(checkIn.photoIds).toHaveLength(1);
      const doc = await db.document.findUniqueOrThrow({ where: { id: checkIn.photoIds[0]! } });
      expect(doc).toMatchObject({ tenantId: a, kind: "image", mimeType: "image/jpeg", name: "Day 7 front — IMG_0001.jpg" });

      const file = await fileRoute(request(`/api/concierge/files/${doc.id}`, { cookie: receptionCookie }), params(doc.id));
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toBe("image/jpeg");
      expect(file.headers.get("cache-control")).toBe("private, max-age=3600");
      expect(file.headers.get("x-content-type-options")).toBe("nosniff");
      expect(Buffer.from(await file.arrayBuffer()).equals(JPEG)).toBe(true);
      expect((await fileRoute(request(`/api/concierge/files/${doc.id}`, { cookie: ownerBCookie }), params(doc.id))).status).toBe(404);
      expect((await fileRoute(request(`/api/concierge/files/${doc.id}`), params(doc.id))).status).toBe(401);
      // A document that is not a check-in photo is not served from here.
      const other = await db.document.create({ data: { tenantId: a, patientId: doc.patientId, name: "Lab report", kind: "pdf", s3Key: doc.s3Key } });
      expect((await fileRoute(request(`/api/concierge/files/${other.id}`, { cookie: ownerCookie }), params(other.id))).status).toBe(404);

      const detail = await call(enrolmentRoute, `/api/concierge/enrolments/${enrolmentId}`, { cookie: ownerCookie }, enrolmentId);
      const answeredPhoto = detail.json.enrolment.tasks.find((t: { id: string }) => t.id === photoTask.id);
      expect(answeredPhoto).toMatchObject({ status: "ANSWERED", checkIn: { photoIds: [doc.id], triage: "OK" } });
    });

    it("rate-limits an address that keeps asking", async () => {
      resetRateLimits();
      const req = () => request("/api/public/check-in/short", { headers: { "x-forwarded-for": "10.200.0.1" } });
      for (let i = 0; i < 60; i++) expect((await publicGet(req(), tokenParams("short"))).status).toBe(404);
      const limited = await publicGet(req(), tokenParams("short"));
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBeTruthy();
      resetRateLimits();
    });
  });

  // ── Staff actions ──────────────────────────────────────────────────────────

  describe("acknowledge and resolve", () => {
    it("lets the nurse acknowledge and resolve with a note; reception can read but not act", async () => {
      await settings(ALWAYS_IN_HOURS);
      const { enrolmentId, token, patient: p } = await sentDay1("Escalated Patient");
      await publicCall("POST", token, { answers: { pain: 8, swelling: false, bleeding: false, fever: false } });
      const escalation = await db.escalation.findFirstOrThrow({ where: { tenantId: a, enrolmentId, level: "HIGH_RISK" } });

      const list = await call(escalationsRoute, "/api/concierge/escalations?status=open", { cookie: receptionCookie });
      expect(list.res.status).toBe(200);
      expect(list.json.escalations.map((e: { id: string }) => e.id)).toContain(escalation.id);
      const row = list.json.escalations.find((e: { id: string }) => e.id === escalation.id);
      expect(row).toMatchObject({ level: "HIGH_RISK", assignedToName: "Nurse Heba", patientName: "Escalated Patient", targetMinutes: 15, acknowledgedWithinTarget: null });

      expect((await call(acknowledgeRoute, `/x`, { method: "POST", cookie: receptionCookie }, escalation.id)).res.status).toBe(403);
      const forbidden = await call(resolveRoute, `/x`, { method: "POST", cookie: receptionCookie, body: { resolution: "Called her" } }, escalation.id);
      expect(forbidden.res.status).toBe(403);
      expect(forbidden.json.error).toBe("forbidden");

      const ack = await call(acknowledgeRoute, `/x`, { method: "POST", cookie: nurseCookie }, escalation.id);
      expect(ack.res.status).toBe(200);
      expect(ack.json.escalation).toMatchObject({ status: "ACKNOWLEDGED", acknowledgedByName: "Nurse Heba", acknowledgedWithinTarget: true });
      expect((await call(acknowledgeRoute, `/x`, { method: "POST", cookie: doctorCookie }, escalation.id)).res.status).toBe(409);

      const blank = await call(resolveRoute, `/x`, { method: "POST", cookie: nurseCookie, body: { resolution: "  " } }, escalation.id);
      expect(blank.res.status).toBe(422);
      const resolved = await call(resolveRoute, `/x`, { method: "POST", cookie: nurseCookie, body: { resolution: "Called her: pain settling with the tablets, review tomorrow" } }, escalation.id);
      expect(resolved.res.status).toBe(200);
      expect(resolved.json.escalation).toMatchObject({ status: "RESOLVED", resolvedByName: "Nurse Heba", resolution: "Called her: pain settling with the tablets, review tomorrow" });
      expect((await call(resolveRoute, `/x`, { method: "POST", cookie: nurseCookie, body: { resolution: "again" } }, escalation.id)).res.status).toBe(409);

      const titles = (await db.timelineEvent.findMany({ where: { tenantId: a, patientId: p.id, kind: "ESCALATION" } })).map((t) => t.title);
      expect(titles).toEqual(expect.arrayContaining(["High risk escalation opened", "Escalation acknowledged", "Escalation resolved"]));
      expect(await db.auditLog.count({ where: { tenantId: a, entityId: escalation.id, action: { in: ["concierge.escalation.acknowledge", "concierge.escalation.resolve"] } } })).toBe(2);
    });

    it("re-notifies an unacknowledged escalation as soon as it is overdue, then every 30 minutes", async () => {
      const { enrolmentId, token } = await sentDay1("Overdue Patient");
      await publicCall("POST", token, { answers: { pain: 1, swelling: false, bleeding: true, fever: false } });
      const escalation = await db.escalation.findFirstOrThrow({ where: { tenantId: a, enrolmentId, level: "HIGH_RISK" } });
      await notifyOverdueEscalations(a, new Date(escalation.dueAt.getTime() - MIN));
      expect(await db.notification.count({ where: { tenantId: a, entityId: escalation.id, title: { startsWith: "Still unacknowledged" } } })).toBe(0);
      const overdue = new Date(escalation.dueAt.getTime() + 2 * MIN);
      expect(await notifyOverdueEscalations(a, overdue)).toBeGreaterThanOrEqual(1);
      const reminders = await db.notification.findMany({ where: { tenantId: a, entityId: escalation.id, title: { startsWith: "Still unacknowledged" } } });
      expect(reminders.map((n) => n.userId).sort()).toEqual([nurse.id, owner.id].sort());
      await notifyOverdueEscalations(a, new Date(overdue.getTime() + 10 * MIN));
      expect(await db.notification.count({ where: { tenantId: a, entityId: escalation.id, title: { startsWith: "Still unacknowledged" } } })).toBe(2);
      await notifyOverdueEscalations(a, new Date(overdue.getTime() + 31 * MIN));
      expect(await db.notification.count({ where: { tenantId: a, entityId: escalation.id, title: { startsWith: "Still unacknowledged" } } })).toBe(4);
      expect((await db.escalation.findUniqueOrThrow({ where: { id: escalation.id } })).details).toMatchObject({ reminders: 2 });
    });
  });

  describe("staff controls", () => {
    it("records an answer from a phone call (source staff), partial answers allowed", async () => {
      const { task, enrolmentId } = await sentDay1("Phone Patient");
      const bad = await call(answerRoute, "/x", { method: "POST", cookie: nurseCookie, body: { answers: { pain: "lots" } } }, task.id);
      expect(bad.res.status).toBe(422);
      expect(bad.json.issues.fieldErrors.pain).toBeDefined();
      const forbidden = await call(answerRoute, "/x", { method: "POST", cookie: receptionCookie, body: { answers: { pain: 2 } } }, task.id);
      expect(forbidden.res.status).toBe(403);
      const { res, json } = await call(answerRoute, "/x", { method: "POST", cookie: nurseCookie, body: { answers: { pain: 6, fever: false }, freeText: "Said the swelling is going down" } }, task.id);
      expect(res.status).toBe(201);
      expect(json).toMatchObject({ triage: "WATCH", checkIn: { source: "staff", answers: { pain: 6, fever: false } }, escalation: { level: "WATCH", status: "OPEN" } });
      const event = await db.timelineEvent.findFirst({ where: { tenantId: a, refId: json.checkIn.id } });
      expect(event?.title).toBe("Day 1 check-in answered · Watch (by phone)");
      expect((await call(answerRoute, "/x", { method: "POST", cookie: nurseCookie, body: { answers: { pain: 1 } } }, task.id)).res.status).toBe(409);
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "concierge.checkin.submit", entityId: json.checkIn.id } });
      expect(audit).toMatchObject({ actorId: nurse.id });
      expect(enrolmentId).toBeTruthy();
    });

    it("sends a step now, skips one, pauses, resumes and stops (the open link dies)", async () => {
      const { enrolmentId, token } = await sentDay1("Controls Patient");
      const tasks = await tasksOf(enrolmentId);
      const day3 = tasks[2]!;
      const day7 = tasks[3]!;

      const sent = await call(sendRoute, "/x", { method: "POST", cookie: nurseCookie }, day3.id);
      expect(sent.res.status).toBe(200);
      expect(sent.json).toMatchObject({ task: { id: day3.id, status: "SENT", attempts: 1 }, delivery: "LOGGED" });
      expect(sent.text).not.toMatch(/check-in\//);
      expect((await call(sendRoute, "/x", { method: "POST", cookie: receptionCookie }, day3.id)).res.status).toBe(403);

      expect((await call(skipRoute, "/x", { method: "POST", cookie: nurseCookie }, day7.id)).json).toEqual({ task: { id: day7.id, status: "SKIPPED" } });
      expect((await call(skipRoute, "/x", { method: "POST", cookie: nurseCookie }, day7.id)).res.status).toBe(409);
      // Instructions that already went out are done, not skippable.
      expect(tasks[0]).toMatchObject({ kind: "INSTRUCTION", status: "SENT" });
      expect((await call(skipRoute, "/x", { method: "POST", cookie: nurseCookie }, tasks[0]!.id)).res.status).toBe(409);

      const paused = await call(pauseRoute, "/x", { method: "POST", cookie: nurseCookie, body: { reason: "Travelling, will call us" } }, enrolmentId);
      expect(paused.json.enrolment).toMatchObject({ status: "PAUSED", pauseReason: "Travelling, will call us" });
      expect((await call(pauseRoute, "/x", { method: "POST", cookie: nurseCookie }, enrolmentId)).res.status).toBe(409);
      // Paused: nothing new goes out, but the link already sent still answers.
      expect((await publicCall("GET", token)).res.status).toBe(200);
      expect((await call(resumeRoute, "/x", { method: "POST", cookie: nurseCookie }, enrolmentId)).json.enrolment.status).toBe("ACTIVE");

      expect((await call(stopRoute, "/x", { method: "POST", cookie: nurseCookie, body: {} }, enrolmentId)).res.status).toBe(422);
      const stopped = await call(stopRoute, "/x", { method: "POST", cookie: nurseCookie, body: { reason: "Patient asked us to stop" } }, enrolmentId);
      expect(stopped.json.enrolment).toMatchObject({ status: "STOPPED", stopReason: "Patient asked us to stop" });
      const after = await tasksOf(enrolmentId);
      expect(after.filter((t) => t.status === "PENDING" || (t.status === "SENT" && t.kind !== "INSTRUCTION"))).toHaveLength(0);
      expect((await publicCall("GET", token)).res.status).toBe(404);
      expect((await call(sendRoute, "/x", { method: "POST", cookie: nurseCookie }, day3.id)).res.status).toBe(409);
      expect((await call(stopRoute, "/x", { method: "POST", cookie: nurseCookie, body: { reason: "again" } }, enrolmentId)).res.status).toBe(409);
      const actions = (await db.auditLog.findMany({ where: { tenantId: a, entityId: { in: [enrolmentId, day3.id, day7.id] } } })).map((r) => r.action);
      expect(actions).toEqual(expect.arrayContaining(["concierge.task.resend", "concierge.task.skip", "concierge.enrolment.pause", "concierge.enrolment.resume", "concierge.enrolment.stop"]));
    });

    it("lists enrolments with filters and counts, and shows one with its tasks", async () => {
      const list = await call(enrolmentsRoute, "/api/concierge/enrolments?status=ACTIVE&pageSize=5", { cookie: receptionCookie });
      expect(list.res.status).toBe(200);
      expect(list.json.enrolments.length).toBeLessThanOrEqual(5);
      expect(list.json.enrolments.every((e: { status: string }) => e.status === "ACTIVE")).toBe(true);
      expect(list.json.counts.ACTIVE).toBeGreaterThan(0);
      expect(list.json.counts.STOPPED).toBeGreaterThanOrEqual(1);
      const search = await call(enrolmentsRoute, "/api/concierge/enrolments?q=karim", { cookie: receptionCookie });
      expect(search.json.enrolments.map((e: { patient: { fullName: string } }) => e.patient.fullName)).toEqual(["Karim Nabil"]);
      const one = search.json.enrolments[0];
      expect(one).toMatchObject({ treatment: { key: "hair-transplant" }, protocol: { version: 1, lengthDays: 365 }, procedure: { doctorName: "Dr. On Call" } });
      const detail = await call(enrolmentRoute, "/x", { cookie: receptionCookie }, one.id);
      expect(detail.json.enrolment.tasks).toHaveLength(10);
      expect(detail.json.enrolment.tasks[1]).toMatchObject({ dayLabel: "Day 1", kind: "CHECK_IN", hasHighRisk: true });
      expect(["SENT", "MISSED"]).toContain(detail.json.enrolment.tasks[1].status);
      expect((await call(enrolmentsRoute, "/api/concierge/enrolments?status=NOPE", { cookie: ownerCookie })).res.status).toBe(422);
    });
  });

  // ── Protocols ──────────────────────────────────────────────────────────────

  describe("protocol versions", () => {
    it("copies the active version into a draft, validates edits, and approval retires the previous", async () => {
      const prp = treatments.get("prp-hair")!;
      const listed = await call(protocolsRoute, "/api/concierge/protocols", { cookie: receptionCookie });
      expect(listed.res.status).toBe(200);
      const prpRow = listed.json.treatments.find((t: { treatment: { key: string } }) => t.treatment.key === "prp-hair");
      expect(prpRow.active).toMatchObject({ version: 1, status: "ACTIVE" });
      const v1 = prpRow.active.id as string;

      expect((await call(createProtocolRoute, "/x", { method: "POST", cookie: receptionCookie, body: { treatmentId: prp } })).res.status).toBe(403);
      const draft = await call(createProtocolRoute, "/x", { method: "POST", cookie: nurseCookie, body: { treatmentId: prp } });
      expect(draft.res.status).toBe(201);
      expect(draft.json.protocol).toMatchObject({ version: 2, status: "DRAFT", notes: "Copied from v1" });
      expect(draft.json.protocol.steps).toEqual(prpRow.active.steps);
      const v2 = draft.json.protocol.id as string;
      const twice = await call(createProtocolRoute, "/x", { method: "POST", cookie: nurseCookie, body: { treatmentId: prp } });
      expect(twice.res.status).toBe(409);
      expect(twice.json).toMatchObject({ error: "draft_exists", protocolId: v2 });

      const steps = draft.json.protocol.steps;
      steps[1].questions[0].expected = { max: 2 };
      steps[1].questions[0].highRisk = true;
      const edited = await call(patchProtocolRoute, "/x", { method: "PATCH", cookie: nurseCookie, body: { name: "PRP aftercare (2026)", steps } }, v2);
      expect(edited.res.status).toBe(200);
      expect(edited.json.protocol).toMatchObject({ name: "PRP aftercare (2026)" });
      expect(edited.json.protocol.steps[1].questions[0]).toMatchObject({ expected: { max: 2 }, highRisk: true });
      const invalid = await call(patchProtocolRoute, "/x", { method: "PATCH", cookie: nurseCookie, body: { steps: [{ offsetHours: 24, kind: "CHECK_IN", title: "Empty", body: { ar: "", en: "x" } }] } }, v2);
      expect(invalid.res.status).toBe(422);
      expect((await call(patchProtocolRoute, "/x", { method: "PATCH", cookie: nurseCookie, body: { name: "x" } }, v1)).json.error).toBe("draft_only");

      // A protocol sets clinical thresholds: a clinician approves it.
      expect((await call(approveRoute, "/x", { method: "POST", cookie: nurseCookie }, v2)).res.status).toBe(403);
      const approved = await call(approveRoute, "/x", { method: "POST", cookie: doctorCookie }, v2);
      expect(approved.res.status).toBe(200);
      expect(approved.json.protocol).toMatchObject({ status: "ACTIVE", version: 2 });
      const old = await call(protocolRoute, "/x", { cookie: ownerCookie }, v1);
      expect(old.json.protocol).toMatchObject({ status: "RETIRED", version: 1 });
      expect(old.json.protocol.retiredAt).toBeTruthy();
      expect((await call(approveRoute, "/x", { method: "POST", cookie: doctorCookie }, v2)).res.status).toBe(409);

      // New procedures get the new version; retiring it leaves new ones unenrolled.
      const p = await patient("PRP Patient");
      const enrolment = await enrolOnSignedProcedure(a, (await signed(p.id, "prp-hair", PERFORMED)).id);
      expect(enrolment!.protocolId).toBe(v2);
      expect((await call(retireRoute, "/x", { method: "POST", cookie: nurseCookie }, v1)).res.status).toBe(409);
      expect((await call(retireRoute, "/x", { method: "POST", cookie: nurseCookie }, v2)).json.protocol.status).toBe("RETIRED");
      expect(await enrolOnSignedProcedure(a, (await signed(p.id, "prp-hair", cairoAt(0, 11))).id)).toBeNull();
      expect(await db.auditLog.count({ where: { tenantId: a, entityId: v2, action: { in: ["concierge.protocol.create", "concierge.protocol.update", "concierge.protocol.approve", "concierge.protocol.retire"] } } })).toBe(4);
    });

    it("discards a draft made by mistake, and nothing else", async () => {
      const acne = treatments.get("acne")!;
      const draft = await call(createProtocolRoute, "/x", { method: "POST", cookie: nurseCookie, body: { treatmentId: acne } });
      expect(draft.res.status).toBe(201);
      const id = draft.json.protocol.id as string;
      expect((await call(discardProtocolRoute, "/x", { method: "DELETE", cookie: receptionCookie }, id)).res.status).toBe(403);
      expect((await call(discardProtocolRoute, "/x", { method: "DELETE", cookie: ownerBCookie }, id)).res.status).toBe(404);
      const gone = await call(discardProtocolRoute, "/x", { method: "DELETE", cookie: nurseCookie }, id);
      expect(gone.json).toEqual({ discarded: { id, version: draft.json.protocol.version } });
      expect(await db.protocol.count({ where: { id } })).toBe(0);
      const active = await db.protocol.findFirstOrThrow({ where: { tenantId: a, treatmentId: acne, status: "ACTIVE" } });
      expect((await call(discardProtocolRoute, "/x", { method: "DELETE", cookie: nurseCookie }, active.id)).json.error).toBe("draft_only");
      expect(await db.auditLog.count({ where: { tenantId: a, entityId: id, action: "concierge.protocol.discard" } })).toBe(1);
    });
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  describe("roster and hours", () => {
    it("is set by the owner only, with clinical staff of the clinic", async () => {
      expect((await settings(ALWAYS_IN_HOURS, nurseCookie)).res.status).toBe(403);
      const body = (roster: object) => ({ hours: { days: [6, 0, 1, 2, 3, 4], start: "09:00", end: "21:00" }, roster, ackMinutes: { inHours: 15, outOfHours: 30 } });
      const desk = await call(putSettingsRoute, "/x", { method: "PUT", cookie: ownerCookie, body: body({ inHoursUserId: receptionist.id }) });
      expect(desk.res.status).toBe(422);
      expect(desk.json.issues.fieldErrors.inHoursUserId).toBeDefined();
      expect((await call(putSettingsRoute, "/x", { method: "PUT", cookie: ownerCookie, body: body({ backupUserId: ownerB.id }) })).res.status).toBe(404);
      const badTime = await call(putSettingsRoute, "/x", { method: "PUT", cookie: ownerCookie, body: { ...body({}), hours: { days: [1], start: "9am", end: "21:00" } } });
      expect(badTime.res.status).toBe(422);

      const saved = await call(putSettingsRoute, "/x", { method: "PUT", cookie: ownerCookie, body: body({ inHoursUserId: nurse.id, outOfHoursUserId: doctor.id, backupUserId: owner.id }) });
      expect(saved.res.status).toBe(200);
      expect(saved.json.settings).toEqual({
        hours: { days: [0, 1, 2, 3, 4, 6], start: "09:00", end: "21:00" },
        roster: { inHoursUserId: nurse.id, outOfHoursUserId: doctor.id, backupUserId: owner.id },
        ackMinutes: { inHours: 15, outOfHours: 30 },
      });
      const read = await call(settingsRoute, "/x", { cookie: receptionCookie });
      expect(read.res.status).toBe(200);
      expect(read.json.candidates.map((c: { id: string }) => c.id)).not.toContain(receptionist.id);
      expect(read.json.effective.inHours).toMatchObject({ id: nurse.id, isDefault: false });
      expect(read.json.onCall).toMatchObject({ ackMinutes: expect.any(Number) });
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "concierge.settings.update" }, orderBy: { createdAt: "desc" } });
      expect(audit).toMatchObject({ actorId: owner.id });
      await settings(ALWAYS_IN_HOURS);
    });
  });

  // ── Board ──────────────────────────────────────────────────────────────────

  describe("board", () => {
    it("computes the answer rate and the high-risk acknowledgement against their targets", async () => {
      const tc = await createTenant({ slug: `conc-c-${Date.now().toString(36)}` });
      created.push(tc.id);
      await ensureDefaultTreatments(tc.id);
      const ownerC = await createUser({ tenantId: tc.id, role: "CLINIC_OWNER", fullName: "Owner C" });
      const p = await patient("Board Patient", "en", tc.id);
      const proc = await signed(p.id, "hair-transplant", new Date(Date.now() - 20 * 86_400_000), tc.id);
      const enrolment = (await enrolOnSignedProcedure(tc.id, proc.id))!;
      const now = Date.now();
      await db.conciergeTask.deleteMany({ where: { enrolmentId: enrolment.enrolmentId } });
      // Ten check-ins sent three days ago: nine answered (one after the reminder), one missed → 90 %.
      await db.conciergeTask.createMany({
        data: Array.from({ length: 10 }, (_, i) => ({
          tenantId: tc.id,
          enrolmentId: enrolment.enrolmentId,
          stepIndex: 1,
          kind: "CHECK_IN" as const,
          title: `Check-in ${i}`,
          dueAt: new Date(now - 3 * 86_400_000),
          sentAt: new Date(now - 3 * 86_400_000),
          status: i < 9 ? ("ANSWERED" as const) : ("MISSED" as const),
          answeredAt: i < 9 ? new Date(now - 3 * 86_400_000 + (i === 0 ? 30 : 2) * HOUR) : null,
          attempts: i === 0 ? 2 : 1,
        })),
      });
      const esc = (createdAgo: number, target: number, ackAfter: number | null) => ({
        tenantId: tc.id,
        kind: "CONCIERGE" as const,
        level: "HIGH_RISK" as const,
        status: ackAfter === null ? ("OPEN" as const) : ("RESOLVED" as const),
        enrolmentId: enrolment.enrolmentId,
        patientId: p.id,
        summary: "Day 1 check-in: bleeding yes",
        createdAt: new Date(now - createdAgo * MIN),
        dueAt: new Date(now - createdAgo * MIN + target * MIN),
        acknowledgedAt: ackAfter === null ? null : new Date(now - createdAgo * MIN + ackAfter * MIN),
        resolvedAt: ackAfter === null ? null : new Date(now - createdAgo * MIN + ackAfter * MIN),
        assignedToId: ownerC.id,
      });
      await db.escalation.createMany({ data: [esc(300, 15, 10), esc(200, 30, 40), esc(60, 15, null)] });

      const board = await call(boardRoute, "/api/concierge/board", { cookie: await sessionCookieFor(ownerC.id) });
      expect(board.res.status).toBe(200);
      expect(board.json.board.kpis.answerRate).toEqual({ answered: 9, sent: 10, missed: 1, afterReminder: 1, pct: 90, target: 90 });
      // 1 of 3 within target (the open one is past its target), median of the acknowledged ones (10 and 40 min).
      expect(board.json.board.kpis.highRiskAck).toEqual({ within: 1, counted: 3, pct: 33.3, medianMinutes: 25, target: 100 });
      expect(board.json.board.kpis).toMatchObject({ openEscalations: 1, overdueEscalations: 1, activeEnrolments: 1 });
      expect(board.json.board.escalations).toHaveLength(1);
      expect(board.json.board.onCall).toMatchObject({ assigneeName: "Owner C", ackMinutes: expect.any(Number) });
    });

    it("shows the clinic's own escalations, open ones first, to anyone with concierge:read", async () => {
      const board = await call(boardRoute, "/api/concierge/board", { cookie: receptionCookie });
      expect(board.res.status).toBe(200);
      const statuses = board.json.board.escalations.map((e: { status: string }) => e.status);
      expect(statuses.lastIndexOf("OPEN")).toBeLessThan(statuses.indexOf("ACKNOWLEDGED") === -1 ? Infinity : statuses.indexOf("ACKNOWLEDGED"));
      expect(board.json.board.escalations.every((e: { patientName: string | null }) => e.patientName !== "Patient Of B")).toBe(true);
      expect(Array.isArray(board.json.board.awaiting)).toBe(true);
    });
  });

  // ── RBAC & isolation ───────────────────────────────────────────────────────

  describe("access", () => {
    it("401 without a session, 403 without concierge:read, 403 cross-origin", async () => {
      expect((await call(boardRoute, "/api/concierge/board")).res.status).toBe(401);
      expect((await call(boardRoute, "/api/concierge/board", { cookie: assistantCookie })).res.status).toBe(403);
      const enrolment = await db.conciergeEnrolment.findFirstOrThrow({ where: { tenantId: a, status: "ACTIVE" } });
      const cross = await call(pauseRoute, "/x", { method: "POST", cookie: nurseCookie, headers: { origin: "https://evil.example" } }, enrolment.id);
      expect(cross.res.status).toBe(403);
      expect((await db.conciergeEnrolment.findUniqueOrThrow({ where: { id: enrolment.id } })).status).toBe("ACTIVE");
    });

    it("answers 404 for another tenant's enrolment, task, escalation and protocol", async () => {
      const enrolment = await db.conciergeEnrolment.findFirstOrThrow({ where: { tenantId: a, status: "ACTIVE" }, include: { tasks: true } });
      const escalation = await db.escalation.findFirstOrThrow({ where: { tenantId: a, kind: "CONCIERGE" } });
      const protocol = await db.protocol.findFirstOrThrow({ where: { tenantId: a } });
      const pending = enrolment.tasks.find((t) => t.status === "PENDING")!;
      expect((await call(enrolmentRoute, "/x", { cookie: ownerBCookie }, enrolment.id)).res.status).toBe(404);
      expect((await call(pauseRoute, "/x", { method: "POST", cookie: ownerBCookie }, enrolment.id)).res.status).toBe(404);
      expect((await call(sendRoute, "/x", { method: "POST", cookie: ownerBCookie }, pending.id)).res.status).toBe(404);
      expect((await call(skipRoute, "/x", { method: "POST", cookie: ownerBCookie }, pending.id)).res.status).toBe(404);
      expect((await call(answerRoute, "/x", { method: "POST", cookie: ownerBCookie, body: { answers: {} } }, pending.id)).res.status).toBe(404);
      expect((await call(acknowledgeRoute, "/x", { method: "POST", cookie: ownerBCookie }, escalation.id)).res.status).toBe(404);
      expect((await call(resolveRoute, "/x", { method: "POST", cookie: ownerBCookie, body: { resolution: "x" } }, escalation.id)).res.status).toBe(404);
      expect((await call(protocolRoute, "/x", { cookie: ownerBCookie }, protocol.id)).res.status).toBe(404);
      expect((await call(approveRoute, "/x", { method: "POST", cookie: ownerBCookie }, protocol.id)).res.status).toBe(404);
      const foreignTreatment = await call(createProtocolRoute, "/x", { method: "POST", cookie: ownerBCookie, body: { treatmentId: treatments.get("acne") } });
      expect(foreignTreatment.res.status).toBe(404);
      expect((await db.conciergeTask.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
      const listB = await call(enrolmentsRoute, "/api/concierge/enrolments", { cookie: ownerBCookie });
      expect(listB.json.total).toBe(0);
    });
  });

  // ── Jobs ───────────────────────────────────────────────────────────────────

  describe("jobs", () => {
    it("registers the dispatch every minute and the overdue check every five", async () => {
      expect(jobs.map((j) => [j.name, j.everyMinutes])).toEqual([
        ["concierge-dispatch", 1],
        ["concierge-ack-overdue", 5],
      ]);
      const summary = await jobs[1]!.run({ now: new Date(), log: () => undefined });
      expect(summary).toMatch(/^re-notified \d+ overdue escalation/);
    });
  });
});

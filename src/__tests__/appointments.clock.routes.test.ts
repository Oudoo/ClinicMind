/**
 * The appointment book follows the clinic clock, over the real route handlers
 * and the test database (audit #11): no booking or move into the past and none
 * outside the opening hours unless the owner asks on purpose (audited), no
 * check-in on another day, no no-show before the start, no consultation
 * started on a future day or completed before its start, and doctor pickers
 * that list clinicians only (nurses for procedures).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

import { db } from "@/lib/db";
import { addDays, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { POST as createRoute } from "@/app/api/appointments/route";
import { PATCH as patchRoute } from "@/app/api/appointments/[id]/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { GET as cliniciansRoute } from "@/app/api/appointments/clinicians/route";
import { assertBookableTime, BookingTimeError } from "@/modules/appointments/service";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const TZ = "Africa/Cairo";
const MIN = 60_000;
const params = (id: string) => ({ params: Promise.resolve({ id }) });

/** `HH:mm` on the clinic clock, `days` calendar days from today. */
function clinicTime(days: number, hhmm: string): Date {
  const p = zonedParts(addDays(new Date(), days, TZ), TZ);
  const [hour, minute] = hhmm.split(":").map(Number);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour, minute }, TZ);
}

/** The first day offset ≥ `from` whose clinic weekday passes `test`. */
function dayWhere(from: number, test: (weekday: number) => boolean): number {
  for (let d = from; d < from + 8; d++) if (test(zonedParts(addDays(new Date(), d, TZ), TZ).weekday)) return d;
  throw new Error("no such day");
}

const span = (start: Date, minutes = 30) => ({ startsAt: start.toISOString(), endsAt: new Date(start.getTime() + minutes * MIN).toISOString() });

describe.skipIf(!dbTestsEnabled)("appointments follow the clinic clock", () => {
  const created: string[] = [];
  let a: string;
  let ownerCookie: string;
  let deskCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let doctor: { id: string };
  let doctorB: { id: string };
  const P = { mona: "", ramy: "", sara: "", omar: "", hala: "" };

  async function book(body: Record<string, unknown>, cookie = deskCookie) {
    const res = await createRoute(request("/api/appointments", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  }

  async function move(id: string, body: Record<string, unknown>, cookie = deskCookie) {
    const res = await patchRoute(request(`/api/appointments/${id}`, { method: "PATCH", cookie, body }), params(id));
    return { res, json: await res.json() };
  }

  async function transition(id: string, body: Record<string, unknown>, cookie = deskCookie) {
    const res = await transitionRoute(request(`/api/appointments/${id}/transition`, { method: "POST", cookie, body }), params(id));
    return { res, json: await res.json() };
  }

  async function clinicians(qs = "", cookie = deskCookie) {
    const res = await cliniciansRoute(request(`/api/appointments/clinicians${qs}`, { cookie }));
    return { res, json: await res.json() };
  }

  /** A row written straight to the database, the way the seed and old data arrive (no rules applied). */
  function row(status: "SCHEDULED" | "CHECKED_IN" | "IN_PROGRESS" | "NO_SHOW" | "WAITLISTED", start: Date, patientId: string, minutes = 30) {
    return db.appointment.create({
      data: { tenantId: a, patientId, status, startsAt: start, endsAt: new Date(start.getTime() + minutes * MIN) },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    const stamp = Date.now().toString(36);
    const tenantA = await createTenant({ slug: `clock-a-${stamp}` });
    const tenantB = await createTenant({ slug: `clock-b-${stamp}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA.id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Dr. Owner" });
    const desk = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant" });
    doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Clinician" });
    await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Not Marked", isClinician: false });
    await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse Heba" });
    await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "AI Lead", isClinician: false });
    await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Gone", status: "DISABLED" });
    const ownerB = await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorB = await createUser({ tenantId: tenantB.id, role: "DOCTOR", fullName: "Dr. Beta" });
    ownerCookie = await sessionCookieFor(owner.id);
    deskCookie = await sessionCookieFor(desk.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    for (const key of Object.keys(P) as (keyof typeof P)[]) {
      P[key] = (await db.patient.create({ data: { tenantId: a, fullName: `Patient ${key}` } })).id;
    }
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("booking into the past", () => {
    it("refuses a booking a week ago at 03:00 (422 in_the_past); reception cannot override, the owner can on purpose and it is audited", async () => {
      const weekAgo3am = span(clinicTime(-7, "03:00"));

      const desk = await book({ patientId: P.mona, doctorId: doctor.id, ...weekAgo3am });
      expect(desk.res.status).toBe(422);
      expect(desk.json).toMatchObject({ error: "in_the_past", overridable: false });
      expect(desk.json.message).toMatch(/has already passed.*only the clinic owner can back-enter/);
      const deskForced = await book({ patientId: P.mona, doctorId: doctor.id, ...weekAgo3am, allowPast: true, allowOutsideHours: true });
      expect(deskForced.res.status).toBe(422);
      expect(deskForced.json.error).toBe("in_the_past");

      const owner = await book({ patientId: P.mona, doctorId: doctor.id, ...weekAgo3am }, ownerCookie);
      expect(owner.res.status).toBe(422);
      expect(owner.json).toMatchObject({ error: "in_the_past", overridable: true });
      // 03:00 is outside the opening hours too: the owner has to confirm that separately.
      const pastOnly = await book({ patientId: P.mona, doctorId: doctor.id, ...weekAgo3am, allowPast: true }, ownerCookie);
      expect(pastOnly.res.status).toBe(422);
      expect(pastOnly.json).toMatchObject({ error: "outside_hours", overridable: true, hours: { start: "10:00", end: "20:00" } });
      expect(await db.appointment.count({ where: { tenantId: a, patientId: P.mona } })).toBe(0);

      const backEntry = await book({ patientId: P.mona, doctorId: doctor.id, ...weekAgo3am, allowPast: true, allowOutsideHours: true }, ownerCookie);
      expect(backEntry.res.status).toBe(201);
      const log = await db.auditLog.findFirst({ where: { tenantId: a, action: "appointment.create", entityId: backEntry.json.appointment.id } });
      expect(log?.after).toMatchObject({ allowPast: true, allowOutsideHours: true, startsAt: weekAgo3am.startsAt });
    });

    it("lets a booking start up to 15 minutes ago (a walk-in entered late), not earlier", async () => {
      const tenMinutesAgo = span(new Date(Date.now() - 10 * MIN));
      // The owner books outside the hours on purpose so the test does not depend on the time of day.
      const ok = await book({ patientId: P.ramy, ...tenMinutesAgo, allowOutsideHours: true }, ownerCookie);
      expect(ok.res.status).toBe(201);
      const log = await db.auditLog.findFirst({ where: { tenantId: a, action: "appointment.create", entityId: ok.json.appointment.id } });
      expect(log?.after).not.toHaveProperty("allowPast");

      const late = await book({ patientId: P.ramy, ...span(new Date(Date.now() - 20 * MIN)), allowOutsideHours: true, allowPatientOverlap: true }, ownerCookie);
      expect(late.res.status).toBe(422);
      expect(late.json.error).toBe("in_the_past");
    });

    it("offers the same check to callers that must look before they write (the CRM's lead booking)", async () => {
      const past = { startsAt: clinicTime(-7, "11:00"), endsAt: clinicTime(-7, "11:30") };
      await expect(assertBookableTime(a, past)).rejects.toMatchObject({ code: "in_the_past", status: 422 });
      await expect(assertBookableTime(a, past)).rejects.toBeInstanceOf(BookingTimeError);
      const friday = dayWhere(1, (w) => w === 5);
      await expect(assertBookableTime(a, { startsAt: clinicTime(friday, "11:00"), endsAt: clinicTime(friday, "11:30") })).rejects.toMatchObject({ code: "outside_hours" });
      const open = dayWhere(2, (w) => w !== 5);
      await expect(assertBookableTime(a, { startsAt: clinicTime(open, "11:00"), endsAt: clinicTime(open, "11:30") })).resolves.toBeUndefined();
    });

    it("validates the override flags", async () => {
      const day = dayWhere(2, (w) => w !== 5);
      const res = await book({ patientId: P.sara, doctorId: doctor.id, ...span(clinicTime(day, "11:00")), allowPast: "yes" }, ownerCookie);
      expect(res.res.status).toBe(422);
      expect(res.json.error).toBe("validation_error");
      expect(res.json.issues.fieldErrors.allowPast).toBeDefined();
    });
  });

  describe("opening hours", () => {
    it("refuses Friday (closed) and times outside 10:00–20:00 with 422 outside_hours; 19:30–20:00 fits", async () => {
      const friday = dayWhere(1, (w) => w === 5);
      const fri = await book({ patientId: P.sara, doctorId: doctor.id, ...span(clinicTime(friday, "11:00")) });
      expect(fri.res.status).toBe(422);
      expect(fri.json).toMatchObject({ error: "outside_hours", overridable: false, message: "The clinic is closed on Fridays. Opening hours: Sat–Thu 10:00–20:00." });

      const open = dayWhere(2, (w) => w !== 5);
      const early = await book({ patientId: P.sara, doctorId: doctor.id, ...span(clinicTime(open, "08:00")) });
      expect(early.res.status).toBe(422);
      expect(early.json.error).toBe("outside_hours");
      const overrun = await book({ patientId: P.sara, doctorId: doctor.id, ...span(clinicTime(open, "19:45")) });
      expect(overrun.res.status).toBe(422);
      const last = await book({ patientId: P.sara, doctorId: doctor.id, ...span(clinicTime(open, "19:30")) });
      expect(last.res.status).toBe(201);
      expect(await db.appointment.count({ where: { tenantId: a, patientId: P.sara } })).toBe(1);
    });

    it("the owner may book on a closed day on purpose; it is audited", async () => {
      const friday = dayWhere(1, (w) => w === 5);
      const res = await book({ patientId: P.omar, doctorId: doctor.id, ...span(clinicTime(friday, "12:00")), allowOutsideHours: true }, ownerCookie);
      expect(res.res.status).toBe(201);
      const log = await db.auditLog.findFirst({ where: { tenantId: a, action: "appointment.create", entityId: res.json.appointment.id } });
      expect(log?.after).toMatchObject({ allowOutsideHours: true });
      expect(log?.after).not.toHaveProperty("allowPast");
    });
  });

  describe("rescheduling", () => {
    it("refuses a move into the past or outside the hours for reception; the owner may, audited", async () => {
      const open = dayWhere(3, (w) => w !== 5);
      const id = (await book({ patientId: P.hala, doctorId: doctor.id, ...span(clinicTime(open, "12:00")) })).json.appointment.id as string;

      const past = await move(id, span(clinicTime(-7, "11:00")));
      expect(past.res.status).toBe(422);
      expect(past.json).toMatchObject({ error: "in_the_past", overridable: false });
      const friday = dayWhere(1, (w) => w === 5);
      const closed = await move(id, span(clinicTime(friday, "11:00")));
      expect(closed.res.status).toBe(422);
      expect(closed.json.error).toBe("outside_hours");
      expect((await db.appointment.findUniqueOrThrow({ where: { id } })).startsAt.toISOString()).toBe(clinicTime(open, "12:00").toISOString());

      const owner = await move(id, { ...span(clinicTime(-7, "11:00")), allowPast: true, allowOutsideHours: true }, ownerCookie);
      expect(owner.res.status).toBe(200);
      const log = await db.auditLog.findFirst({ where: { tenantId: a, action: "appointment.reschedule", entityId: id } });
      expect(log?.after).toMatchObject({ allowPast: true });
    });

    it("moving only the end of a booking that started a while ago does not put it into the past", async () => {
      const start = new Date(Date.now() - 40 * MIN);
      const id = (await book({ patientId: P.hala, ...span(start), allowPast: true, allowOutsideHours: true, allowPatientOverlap: true }, ownerCookie)).json
        .appointment.id as string;
      const longer = await move(id, { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 45 * MIN).toISOString(), allowOutsideHours: true }, ownerCookie);
      expect(longer.res.status).toBe(200);
      const log = await db.auditLog.findFirst({ where: { tenantId: a, action: "appointment.reschedule", entityId: id } });
      expect(log?.after).not.toHaveProperty("allowPast");
    });
  });

  describe("status changes", () => {
    it("a visit nine days away cannot be checked in (409 not_today) or marked a no-show (409 too_early)", async () => {
      const ahead = dayWhere(9, (w) => w !== 5);
      const id = (await book({ patientId: P.omar, doctorId: doctor.id, ...span(clinicTime(ahead, "11:00")) })).json.appointment.id as string;
      expect((await transition(id, { status: "CONFIRMED" })).res.status).toBe(200);

      const checkIn = await transition(id, { status: "CHECKED_IN" });
      expect(checkIn.res.status).toBe(409);
      expect(checkIn.json).toMatchObject({ error: "not_today", from: "CONFIRMED", to: "CHECKED_IN" });
      expect(checkIn.json.message).toMatch(/opens on the day of the appointment/);

      const noShow = await transition(id, { status: "NO_SHOW", reason: "Clicked by mistake" });
      expect(noShow.res.status).toBe(409);
      expect(noShow.json).toMatchObject({ error: "too_early", from: "CONFIRMED", to: "NO_SHOW" });

      const stored = await db.appointment.findUniqueOrThrow({ where: { id } });
      expect(stored).toMatchObject({ status: "CONFIRMED", checkedInAt: null, cancelReason: null });
      expect(await db.timelineEvent.count({ where: { tenantId: a, refId: id, title: { contains: "no-show" } } })).toBe(0);
    });

    it("check-in closes two hours after the slot ended", async () => {
      const { id } = await row("SCHEDULED", new Date(Date.now() - 3 * 60 * MIN), P.ramy);
      const res = await transition(id, { status: "CHECKED_IN" });
      expect(res.res.status).toBe(409);
      expect(res.json.error).toBe("not_today");
    });

    it("a consultation does not start on a future day, nor complete before its start", async () => {
      const tomorrow = await row("CHECKED_IN", clinicTime(1, "11:00"), P.sara);
      const start = await transition(tomorrow.id, { status: "IN_PROGRESS" });
      expect(start.res.status).toBe(409);
      expect(start.json).toMatchObject({ error: "not_today", from: "CHECKED_IN", to: "IN_PROGRESS" });

      const early = await row("IN_PROGRESS", new Date(Date.now() + 60 * MIN), P.mona);
      const complete = await transition(early.id, { status: "COMPLETED" }, ownerCookie);
      expect(complete.res.status).toBe(409);
      expect(complete.json).toMatchObject({ error: "too_early", to: "COMPLETED" });
      expect((await db.appointment.findUniqueOrThrow({ where: { id: early.id } })).status).toBe("IN_PROGRESS");
    });

    it("an old no-show is not re-booked into its slot, and a waitlisted slot that has passed is not promoted", async () => {
      const missed = await row("NO_SHOW", clinicTime(-2, "12:00"), P.omar);
      const rebook = await transition(missed.id, { status: "SCHEDULED" });
      expect(rebook.res.status).toBe(409);
      expect(rebook.json.error).toBe("not_today");

      const waitlisted = await row("WAITLISTED", clinicTime(-2, "13:00"), P.omar);
      const promote = await transition(waitlisted.id, { status: "SCHEDULED" });
      expect(promote.res.status).toBe(422);
      expect(promote.json).toMatchObject({ error: "in_the_past", overridable: false });
      expect((await db.appointment.findUniqueOrThrow({ where: { id: waitlisted.id } })).status).toBe("WAITLISTED");
    });

    it("another tenant's appointment is a 404 before any clock rule", async () => {
      const { id } = await row("SCHEDULED", clinicTime(5, "11:00"), P.hala);
      const res = await transition(id, { status: "NO_SHOW" }, ownerBCookie);
      expect(res.res.status).toBe(404);
    });
  });

  describe("GET /api/appointments/clinicians", () => {
    it("lists the clinicians only: no nurse, no non-clinical owner, no unmarked or disabled doctor, no other tenant", async () => {
      const { res, json } = await clinicians();
      expect(res.status).toBe(200);
      const staff = json.staff as { id: string; fullName: string; role: string }[];
      expect(staff.map((s) => s.fullName).sort()).toEqual(["Dr. Clinician", "Dr. Owner"]);
      expect(staff.map((s) => s.id)).not.toContain(doctorB.id);
      expect((await clinicians("?kind=CONSULTATION")).json.staff.map((s: { fullName: string }) => s.fullName).sort()).toEqual(["Dr. Clinician", "Dr. Owner"]);
    });

    it("adds the nurses for a procedure (nurse-led sessions)", async () => {
      const { json } = await clinicians("?kind=PROCEDURE", assistantCookie);
      expect((json.staff as { fullName: string; role: string }[]).map((s) => `${s.fullName}:${s.role}`).sort()).toEqual([
        "Dr. Clinician:DOCTOR",
        "Dr. Owner:CLINIC_OWNER",
        "Nurse Heba:NURSE",
      ]);
    });

    it("validates the kind and needs a session", async () => {
      expect((await clinicians("?kind=SURGERY")).res.status).toBe(422);
      expect((await cliniciansRoute(request("/api/appointments/clinicians"))).status).toBe(401);
    });
  });

  describe("the booked doctor", () => {
    const userId = async (fullName: string) => (await db.user.findFirstOrThrow({ where: { tenantId: a, fullName } })).id;

    it("must be someone the pickers offer: a clinician, or a nurse for a procedure (422 doctor_not_bookable)", async () => {
      const day = dayWhere(3, (w) => w !== 5);
      const nurse = await userId("Nurse Heba");
      const aiLead = await userId("AI Lead");
      const notMarked = await userId("Dr. Not Marked");
      const before = await db.appointment.count({ where: { tenantId: a, patientId: P.sara } });

      for (const [doctorId, label] of [[nurse, "nurse"], [aiLead, "AI lead"], [notMarked, "unmarked doctor"]] as const) {
        const refused = await book({ patientId: P.sara, doctorId, ...span(clinicTime(day, "12:00")) });
        expect(refused.res.status, label).toBe(422);
        expect(refused.json.error, label).toBe("doctor_not_bookable");
      }
      expect(await db.appointment.count({ where: { tenantId: a, patientId: P.sara } })).toBe(before);

      // A nurse-led session is a procedure.
      const procedure = await book({ patientId: P.sara, doctorId: nurse, kind: "PROCEDURE", ...span(clinicTime(day, "13:00")) });
      expect(procedure.res.status).toBe(201);
      // …and stays bookable when moved, but cannot be turned into a consultation with her.
      const moved = await move(procedure.json.appointment.id, span(clinicTime(day, "14:00")));
      expect(moved.res.status).toBe(200);
      const asConsult = await move(procedure.json.appointment.id, { kind: "CONSULTATION" });
      expect(asConsult.res.status).toBe(422);
      expect(asConsult.json.error).toBe("doctor_not_bookable");

      // Moving a visit to a non-clinician is refused too.
      const visit = await book({ patientId: P.hala, doctorId: doctor.id, ...span(clinicTime(day, "15:00")) });
      expect(visit.res.status).toBe(201);
      const toAiLead = await move(visit.json.appointment.id, { doctorId: aiLead });
      expect(toAiLead.res.status).toBe(422);
      expect(toAiLead.json.error).toBe("doctor_not_bookable");
    });
  });
});

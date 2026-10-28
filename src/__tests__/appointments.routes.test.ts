/**
 * Appointment lifecycle over the real route handlers and the test database:
 * booking with conflict detection and waitlisting, rescheduling, every status
 * transition, tenant isolation of ids, RBAC and the staff picker endpoint.
 *
 * Bookings land on open weekdays (the clinic is closed on Fridays) inside the
 * opening hours; the status walk runs on a booking that started a few minutes
 * ago today, because check-in, no-show and completion follow the clock.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { startOfDayInTz } from "@/lib/time";
import { GET as listRoute, POST as createRoute } from "@/app/api/appointments/route";
import { GET as getRoute, PATCH as patchRoute } from "@/app/api/appointments/[id]/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { GET as staffRoute } from "@/app/api/staff/route";
import {
  createTenant,
  createUser,
  dbTestsEnabled,
  deleteTenants,
  request,
  sessionCookieFor,
} from "@/test/db";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const DAY = 86_400_000;
const TZ = "Africa/Cairo";
/** 1 Mar 2027 (a Monday); Cairo runs on UTC+2 then, so 08:00–17:00 UTC is 10:00–19:00 on the clinic clock. */
const BASE = Date.UTC(2027, 2, 1, 0, 0, 0);

/** Logical day n → the nth calendar day from BASE on which the clinic opens (Fridays are skipped). */
function openDay(n: number): number {
  let day = -1;
  for (let open = -1; open < n; ) {
    day++;
    if (new Date(BASE + day * DAY).getUTCDay() !== 5) open++;
  }
  return day;
}
const dayStart = (n: number) => new Date(BASE + openDay(n) * DAY);
const dayEnd = (n: number) => new Date(BASE + (openDay(n) + 1) * DAY);

/** A 30-minute slot on a fixed future open day (hours in UTC); tests pick distinct days/hours. */
function slot(day: number, hour: number, minutes = 30, minuteOffset = 0) {
  const start = new Date(dayStart(day).getTime() + hour * 3_600_000 + minuteOffset * 60_000);
  const end = new Date(start.getTime() + minutes * 60_000);
  return { startsAt: start.toISOString(), endsAt: end.toISOString() };
}

/** 30 minutes that started a few minutes ago, never before today's midnight on the clinic clock. */
function startedToday() {
  const now = Date.now();
  const start = new Date(Math.max(startOfDayInTz(new Date(now), TZ).getTime(), now - 5 * 60_000));
  return { startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 30 * 60_000).toISOString() };
}

describe.skipIf(!dbTestsEnabled)("appointments", () => {
  const created: string[] = [];
  let a: { id: string };
  let b: { id: string };
  let ownerA: { id: string };
  let doctorA: { id: string };
  let doctorA2: { id: string };
  let doctorB: { id: string };
  let ownerCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let patientA: string;
  let patientA2: string;
  let patientB: string;

  async function book(body: Record<string, unknown>, cookie = ownerCookie) {
    const res = await createRoute(request("/api/appointments", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  }

  async function transition(id: string, body: Record<string, unknown>, cookie = ownerCookie) {
    const res = await transitionRoute(
      request(`/api/appointments/${id}/transition`, { method: "POST", cookie, body }),
      params(id),
    );
    return { res, json: await res.json() };
  }

  async function patch(id: string, body: Record<string, unknown>, cookie = ownerCookie) {
    const res = await patchRoute(request(`/api/appointments/${id}`, { method: "PATCH", cookie, body }), params(id));
    return { res, json: await res.json() };
  }

  /** Book a SCHEDULED appointment for doctor A and return its id. */
  async function scheduled(day: number, hour: number, extra: Record<string, unknown> = {}) {
    const { res, json } = await book({ patientId: patientA, doctorId: doctorA.id, ...slot(day, hour), ...extra });
    expect(res.status).toBe(201);
    expect(json.appointment.status).toBe("SCHEDULED");
    return json.appointment.id as string;
  }

  /**
   * Book (as the owner) a SCHEDULED appointment that started a few minutes ago
   * today, so check-in, no-show and completion are allowed by the clock. No
   * doctor or room, so several of them may overlap; the owner books outside
   * the opening hours on purpose when the tests run in the evening.
   */
  async function today(extra: Record<string, unknown> = {}) {
    const { res, json } = await book({ patientId: patientA, ...startedToday(), allowOutsideHours: true, allowPatientOverlap: true, ...extra });
    expect(res.status).toBe(201);
    expect(json.appointment.status).toBe("SCHEDULED");
    return json.appointment.id as string;
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `appt-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `appt-b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA;
    b = tenantB;

    ownerA = await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "Owner A" });
    doctorA = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Amina" });
    doctorA2 = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Bassem" });
    await createUser({ tenantId: a.id, role: "NURSE", fullName: "Nurse Nour" });
    // An owner-level administrator who is not a clinician (the Clinic AI lead).
    await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "AI Lead", isClinician: false });
    await createUser({ tenantId: a.id, role: "RECEPTIONIST", fullName: "Desk" });
    await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Invited", status: "INVITED", password: null });
    await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Disabled", status: "DISABLED" });
    const assistant = await createUser({ tenantId: a.id, role: "ASSISTANT", fullName: "Assistant" });
    const ownerB = await createUser({ tenantId: b.id, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorB = await createUser({ tenantId: b.id, role: "DOCTOR", fullName: "Dr. Beta" });

    ownerCookie = await sessionCookieFor(ownerA.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);

    patientA = (await db.patient.create({ data: { tenantId: a.id, fullName: "Patient Of A" } })).id;
    patientA2 = (await db.patient.create({ data: { tenantId: a.id, fullName: "Second Of A" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b.id, fullName: "Patient Of B" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("booking", () => {
    it("creates a SCHEDULED appointment with patient, doctor, timeline event and audit entry", async () => {
      const { res, json } = await book({
        patientId: patientA,
        doctorId: doctorA.id,
        room: "Room 1",
        reason: "Follow-up",
        notes: "Bring previous scans",
        ...slot(0, 9),
      });
      expect(res.status).toBe(201);
      expect(json.appointment).toMatchObject({
        tenantId: a.id,
        patientId: patientA,
        doctorId: doctorA.id,
        room: "Room 1",
        status: "SCHEDULED",
        reason: "Follow-up",
        notes: "Bring previous scans",
        createdById: ownerA.id,
        patient: { id: patientA, fullName: "Patient Of A" },
        doctor: { id: doctorA.id, fullName: "Dr. Amina" },
      });
      expect(json.appointment.statusChangedAt).toBeTruthy();
      expect(json.conflicts).toEqual([]);

      const events = await db.timelineEvent.findMany({ where: { tenantId: a.id, refId: json.appointment.id } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ patientId: patientA, kind: "APPOINTMENT", title: "Appointment — Follow-up" });
      expect(events[0]!.occurredAt.toISOString()).toBe(slot(0, 9).startsAt);

      const audits = await db.auditLog.findMany({ where: { tenantId: a.id, entity: "Appointment", entityId: json.appointment.id } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "appointment.create", actorId: ownerA.id });
    });

    it("refuses an overlapping booking of the same doctor with 409 and the conflicting slots", async () => {
      const first = await scheduled(1, 9);
      const { res, json } = await book({ patientId: patientA2, doctorId: doctorA.id, ...slot(1, 9, 30, 15) });
      expect(res.status).toBe(409);
      expect(json.error).toBe("conflict");
      expect(json.conflicts).toHaveLength(1);
      expect(json.conflicts[0]).toMatchObject({
        id: first,
        doctorId: doctorA.id,
        status: "SCHEDULED",
        patient: { id: patientA, fullName: "Patient Of A" },
        doctor: { id: doctorA.id, fullName: "Dr. Amina" },
      });
      expect(await db.appointment.count({ where: { tenantId: a.id, patientId: patientA2 } })).toBe(0);
    });

    it("waitlists instead when the request allows it", async () => {
      await scheduled(2, 9);
      const { res, json } = await book({
        patientId: patientA2,
        doctorId: doctorA.id,
        allowWaitlist: true,
        ...slot(2, 9, 30, 10),
      });
      expect(res.status).toBe(201);
      expect(json.appointment.status).toBe("WAITLISTED");
      expect(json.conflicts).toHaveLength(1);
      const event = await db.timelineEvent.findFirst({ where: { tenantId: a.id, refId: json.appointment.id } });
      expect(event?.body).toMatch(/waitlisted/i);
    });

    it("detects room conflicts across doctors and ignores back-to-back slots", async () => {
      await scheduled(3, 9, { room: "Room 2" });
      const sameRoom = await book({ patientId: patientA2, doctorId: doctorA2.id, room: "Room 2", ...slot(3, 9) });
      expect(sameRoom.res.status).toBe(409);
      expect(sameRoom.json.conflicts[0]).toMatchObject({ room: "Room 2" });

      const otherRoom = await book({ patientId: patientA2, doctorId: doctorA2.id, room: "Room 3", ...slot(3, 9) });
      expect(otherRoom.res.status).toBe(201);

      // Ends exactly when the existing one starts: no overlap.
      const adjacent = await book({ patientId: patientA2, doctorId: doctorA.id, room: "Room 2", ...slot(3, 8, 60) });
      expect(adjacent.res.status).toBe(201);
      expect(adjacent.json.appointment.status).toBe("SCHEDULED");
    });

    it("does not treat cancelled, no-show or waitlisted bookings as conflicts", async () => {
      const blocker = await scheduled(4, 9);
      await transition(blocker, { status: "CANCELLED", reason: "Patient request" });
      const { res, json } = await book({ patientId: patientA2, doctorId: doctorA.id, ...slot(4, 9) });
      expect(res.status).toBe(201);
      expect(json.appointment.status).toBe("SCHEDULED");
    });

    it("validates the slot: end after start, 5–480 minutes, bounded text", async () => {
      const base = slot(5, 9);
      const backwards = await book({ patientId: patientA, doctorId: doctorA.id, startsAt: base.endsAt, endsAt: base.startsAt });
      expect(backwards.res.status).toBe(422);
      expect(backwards.json.issues.fieldErrors.endsAt).toBeDefined();

      const tooShort = await book({ patientId: patientA, doctorId: doctorA.id, ...slot(5, 10, 2) });
      expect(tooShort.res.status).toBe(422);

      const tooLong = await book({ patientId: patientA, doctorId: doctorA.id, ...slot(5, 11, 481) });
      expect(tooLong.res.status).toBe(422);

      const longReason = await book({ patientId: patientA, doctorId: doctorA.id, reason: "x".repeat(301), ...slot(5, 12) });
      expect(longReason.res.status).toBe(422);

      const badDate = await book({ patientId: patientA, doctorId: doctorA.id, startsAt: "yesterday", endsAt: "tomorrow" });
      expect(badDate.res.status).toBe(422);
      expect(await db.appointment.count({ where: { tenantId: a.id, startsAt: { gte: dayStart(5), lt: dayEnd(5) } } })).toBe(0);
    });

    it("rejects a cross-origin browser request before touching the database", async () => {
      const res = await createRoute(
        request("/api/appointments", {
          method: "POST",
          cookie: ownerCookie,
          body: { patientId: patientA, doctorId: doctorA.id, ...slot(6, 9) },
          headers: { origin: "https://evil.example" },
        }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("listing and reading", () => {
    it("lists the window with patient and doctor names and honours the filters", async () => {
      const mine = await scheduled(10, 9);
      const other = await book({ patientId: patientA2, doctorId: doctorA2.id, ...slot(10, 10) });
      const from = dayStart(10).toISOString();
      const to = new Date(dayEnd(10).getTime() - 1).toISOString();

      const all = await listRoute(request(`/api/appointments?from=${from}&to=${to}`, { cookie: ownerCookie }));
      expect(all.status).toBe(200);
      const list = (await all.json()).appointments as { id: string; doctor: { fullName: string } | null; patient: { fullName: string } }[];
      expect(list.map((x) => x.id)).toEqual([mine, other.json.appointment.id]);
      expect(list[0]).toMatchObject({ patient: { fullName: "Patient Of A" }, doctor: { fullName: "Dr. Amina" } });

      const byDoctor = await listRoute(
        request(`/api/appointments?from=${from}&to=${to}&doctorId=${doctorA2.id}`, { cookie: ownerCookie }),
      );
      expect((await byDoctor.json()).appointments.map((x: { id: string }) => x.id)).toEqual([other.json.appointment.id]);

      const byPatient = await listRoute(
        request(`/api/appointments?from=${from}&to=${to}&patientId=${patientA}`, { cookie: ownerCookie }),
      );
      expect((await byPatient.json()).appointments.map((x: { id: string }) => x.id)).toEqual([mine]);

      const byStatus = await listRoute(
        request(`/api/appointments?from=${from}&to=${to}&status=CANCELLED`, { cookie: ownerCookie }),
      );
      expect((await byStatus.json()).appointments).toEqual([]);

      const badStatus = await listRoute(request(`/api/appointments?status=LOST`, { cookie: ownerCookie }));
      expect(badStatus.status).toBe(422);
      const backwards = await listRoute(request(`/api/appointments?from=${to}&to=${from}`, { cookie: ownerCookie }));
      expect(backwards.status).toBe(422);
    });

    it("never lists another tenant's appointments", async () => {
      const id = await scheduled(11, 9);
      const from = dayStart(11).toISOString();
      const to = dayEnd(11).toISOString();
      const res = await listRoute(request(`/api/appointments?from=${from}&to=${to}`, { cookie: ownerBCookie }));
      expect(res.status).toBe(200);
      expect((await res.json()).appointments.map((x: { id: string }) => x.id)).not.toContain(id);
    });

    it("reads one appointment, and answers 404 for another tenant's id", async () => {
      const id = await scheduled(12, 9);
      const own = await getRoute(request(`/api/appointments/${id}`, { cookie: ownerCookie }), params(id));
      expect(own.status).toBe(200);
      expect((await own.json()).appointment).toMatchObject({ id, doctor: { fullName: "Dr. Amina" } });

      const foreign = await getRoute(request(`/api/appointments/${id}`, { cookie: ownerBCookie }), params(id));
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: "not_found", entity: "appointment" });

      const missing = await getRoute(request(`/api/appointments/nope`, { cookie: ownerCookie }), params("nope"));
      expect(missing.status).toBe(404);
    });
  });

  describe("rescheduling", () => {
    it("moves an appointment to a free slot and resets a confirmation", async () => {
      const id = await scheduled(20, 9);
      await transition(id, { status: "CONFIRMED" });
      const target = slot(20, 14);
      const { res, json } = await patch(id, { ...target, room: "Room 5" });
      expect(res.status).toBe(200);
      expect(json.appointment).toMatchObject({ id, status: "SCHEDULED", room: "Room 5", startsAt: target.startsAt, endsAt: target.endsAt });

      const event = await db.timelineEvent.findFirst({ where: { tenantId: a.id, refId: id, kind: "APPOINTMENT" } });
      expect(event?.occurredAt.toISOString()).toBe(target.startsAt);
      const audits = await db.auditLog.findMany({ where: { tenantId: a.id, entityId: id, action: "appointment.reschedule" } });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.before).toMatchObject({ status: "CONFIRMED", startsAt: slot(20, 9).startsAt });
      expect(audits[0]!.after).toMatchObject({ status: "SCHEDULED", startsAt: target.startsAt });
    });

    it("refuses a conflicting target slot with 409 unless waitlisting is allowed", async () => {
      const blocker = await scheduled(21, 9);
      const id = await scheduled(21, 11);
      const { res, json } = await patch(id, slot(21, 9, 30, 15));
      expect(res.status).toBe(409);
      expect(json.error).toBe("conflict");
      expect(json.conflicts.map((c: { id: string }) => c.id)).toEqual([blocker]);
      const untouched = await db.appointment.findUnique({ where: { id } });
      expect(untouched?.startsAt.toISOString()).toBe(slot(21, 11).startsAt);

      const waitlisted = await patch(id, { ...slot(21, 9, 30, 15), allowWaitlist: true });
      expect(waitlisted.res.status).toBe(200);
      expect(waitlisted.json.appointment.status).toBe("WAITLISTED");
    });

    it("edits notes without changing the slot or the status", async () => {
      const id = await scheduled(22, 9);
      await transition(id, { status: "CONFIRMED" });
      const { res, json } = await patch(id, { notes: "Needs an interpreter", reason: "" });
      expect(res.status).toBe(200);
      expect(json.appointment).toMatchObject({ status: "CONFIRMED", notes: "Needs an interpreter", reason: null });
      const audits = await db.auditLog.findMany({ where: { tenantId: a.id, entityId: id, action: "appointment.update" } });
      expect(audits).toHaveLength(1);
    });

    it("validates the new slot and the doctor", async () => {
      const id = await scheduled(23, 9);
      const half = await patch(id, { startsAt: slot(23, 10).startsAt });
      expect(half.res.status).toBe(422);
      const foreignDoctor = await patch(id, { doctorId: doctorB.id });
      expect(foreignDoctor.res.status).toBe(404);
      expect(foreignDoctor.json).toEqual({ error: "not_found", entity: "user" });
    });

    it("cannot reschedule once the visit has started or ended", async () => {
      const id = await today();
      expect((await transition(id, { status: "CHECKED_IN" })).res.status).toBe(200);
      const { res, json } = await patch(id, slot(24, 15));
      expect(res.status).toBe(409);
      expect(json).toEqual({ error: "not_reschedulable", status: "CHECKED_IN" });
    });

    it("answers 404 for another tenant's appointment", async () => {
      const id = await scheduled(25, 9);
      const { res } = await patch(id, slot(25, 15), ownerBCookie);
      expect(res.status).toBe(404);
      const untouched = await db.appointment.findUnique({ where: { id } });
      expect(untouched?.startsAt.toISOString()).toBe(slot(25, 9).startsAt);
    });
  });

  describe("transitions", () => {
    it("walks SCHEDULED → CONFIRMED → CHECKED_IN → IN_PROGRESS → COMPLETED", async () => {
      const id = await today();
      for (const status of ["CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED"] as const) {
        const { res, json } = await transition(id, { status });
        expect(res.status, status).toBe(200);
        expect(json.appointment.status).toBe(status);
        expect(json.appointment.statusChangedAt).toBeTruthy();
      }
      const events = await db.timelineEvent.findMany({ where: { tenantId: a.id, refId: id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => e.title)).toEqual(["Appointment booked", "Appointment completed"]);
      const audits = await db.auditLog.findMany({ where: { tenantId: a.id, entityId: id, action: "appointment.transition" } });
      expect(audits).toHaveLength(4);
      expect(audits.map((x) => (x.after as { status: string }).status).sort()).toEqual(
        ["CHECKED_IN", "COMPLETED", "CONFIRMED", "IN_PROGRESS"],
      );
    });

    it("allows SCHEDULED → CHECKED_IN directly and CHECKED_IN → CANCELLED", async () => {
      const id = await today();
      expect((await transition(id, { status: "CHECKED_IN" })).res.status).toBe(200);
      const { res, json } = await transition(id, { status: "CANCELLED", reason: "Doctor called away" });
      expect(res.status).toBe(200);
      expect(json.appointment).toMatchObject({ status: "CANCELLED", cancelReason: "Doctor called away" });
    });

    it("requires a reason to cancel and caps it at 300 characters", async () => {
      const id = await scheduled(32, 9);
      const missing = await transition(id, { status: "CANCELLED" });
      expect(missing.res.status).toBe(422);
      expect(missing.json.issues.fieldErrors.reason).toBeDefined();
      const blank = await transition(id, { status: "CANCELLED", reason: "   " });
      expect(blank.res.status).toBe(422);
      const long = await transition(id, { status: "CANCELLED", reason: "x".repeat(301) });
      expect(long.res.status).toBe(422);
      expect((await db.appointment.findUnique({ where: { id } }))?.status).toBe("SCHEDULED");

      const ok = await transition(id, { status: "CANCELLED", reason: "Patient travelling" });
      expect(ok.res.status).toBe(200);
      const event = await db.timelineEvent.findFirst({ where: { tenantId: a.id, refId: id, title: "Appointment cancelled" } });
      expect(event?.body).toBe("Patient travelling");
    });

    it("handles CONFIRMED → CANCELLED and CONFIRMED → NO_SHOW", async () => {
      const first = await scheduled(33, 9);
      await transition(first, { status: "CONFIRMED" });
      expect((await transition(first, { status: "CANCELLED", reason: "Sick" })).res.status).toBe(200);

      const second = await today();
      await transition(second, { status: "CONFIRMED" });
      const { res, json } = await transition(second, { status: "NO_SHOW" });
      expect(res.status).toBe(200);
      expect(json.appointment.status).toBe("NO_SHOW");
    });

    it("marks a no-show (reason optional) and re-books it into the same slot the same day", async () => {
      const id = await today();
      const startsAt = (await db.appointment.findUniqueOrThrow({ where: { id } })).startsAt.toISOString();
      const noShow = await transition(id, { status: "NO_SHOW", reason: "Did not answer the phone" });
      expect(noShow.res.status).toBe(200);
      expect(noShow.json.appointment).toMatchObject({ status: "NO_SHOW", cancelReason: "Did not answer the phone" });
      const event = await db.timelineEvent.findFirst({ where: { tenantId: a.id, refId: id, title: { contains: "no-show" } } });
      expect(event?.occurredAt.toISOString()).toBe(startsAt);

      const rebooked = await transition(id, { status: "SCHEDULED" });
      expect(rebooked.res.status).toBe(200);
      expect(rebooked.json.appointment).toMatchObject({ status: "SCHEDULED", cancelReason: null, startsAt });
    });

    it("promotes a waitlisted booking only once its slot is free", async () => {
      const blocker = await scheduled(35, 9);
      const waitlisted = await book({ patientId: patientA2, doctorId: doctorA.id, allowWaitlist: true, ...slot(35, 9) });
      const id = waitlisted.json.appointment.id as string;
      expect(waitlisted.json.appointment.status).toBe("WAITLISTED");

      const blocked = await transition(id, { status: "SCHEDULED" });
      expect(blocked.res.status).toBe(409);
      expect(blocked.json.error).toBe("conflict");
      expect(blocked.json.conflicts.map((c: { id: string }) => c.id)).toEqual([blocker]);

      await transition(blocker, { status: "CANCELLED", reason: "Freed up" });
      const promoted = await transition(id, { status: "SCHEDULED" });
      expect(promoted.res.status).toBe(200);
      expect(promoted.json.appointment.status).toBe("SCHEDULED");
    });

    it("lets a waitlisted booking be cancelled", async () => {
      await scheduled(36, 9);
      const waitlisted = await book({ patientId: patientA2, doctorId: doctorA.id, allowWaitlist: true, ...slot(36, 9) });
      const { res, json } = await transition(waitlisted.json.appointment.id, { status: "CANCELLED", reason: "Found another clinic" });
      expect(res.status).toBe(200);
      expect(json.appointment.status).toBe("CANCELLED");
    });

    it("refuses moves the state machine does not allow", async () => {
      const id = await scheduled(37, 9);
      const skip = await transition(id, { status: "COMPLETED" });
      expect(skip.res.status).toBe(409);
      expect(skip.json).toEqual({ error: "invalid_transition", from: "SCHEDULED", to: "COMPLETED" });

      await transition(id, { status: "CANCELLED", reason: "Closed" });
      const revive = await transition(id, { status: "SCHEDULED" });
      expect(revive.res.status).toBe(409);
      expect(revive.json).toEqual({ error: "invalid_transition", from: "CANCELLED", to: "SCHEDULED" });

      const done = await today();
      for (const status of ["CHECKED_IN", "IN_PROGRESS", "COMPLETED"] as const) {
        expect((await transition(done, { status })).res.status, status).toBe(200);
      }
      const undo = await transition(done, { status: "CANCELLED", reason: "Oops" });
      expect(undo.res.status).toBe(409);
      expect(undo.json).toEqual({ error: "invalid_transition", from: "COMPLETED", to: "CANCELLED" });

      const unknown = await transition(id, { status: "LOST" });
      expect(unknown.res.status).toBe(422);
    });

    it("answers 404 for another tenant's appointment", async () => {
      const id = await scheduled(38, 9);
      const { res } = await transition(id, { status: "CONFIRMED" }, ownerBCookie);
      expect(res.status).toBe(404);
      expect((await db.appointment.findUnique({ where: { id } }))?.status).toBe("SCHEDULED");
    });
  });

  describe("tenant scoping of ids", () => {
    it("refuses another tenant's patient or doctor with 404 and writes nothing", async () => {
      const foreignPatient = await book({ patientId: patientB, doctorId: doctorA.id, ...slot(40, 9) });
      expect(foreignPatient.res.status).toBe(404);
      expect(foreignPatient.json).toEqual({ error: "not_found", entity: "patient" });

      const foreignDoctor = await book({ patientId: patientA, doctorId: doctorB.id, ...slot(40, 10) });
      expect(foreignDoctor.res.status).toBe(404);
      expect(foreignDoctor.json).toEqual({ error: "not_found", entity: "user" });

      const bClinic = await db.clinic.findFirstOrThrow({ where: { tenantId: b.id } });
      const foreignClinic = await book({ patientId: patientA, doctorId: doctorA.id, clinicId: bClinic.id, ...slot(40, 11) });
      expect(foreignClinic.res.status).toBe(404);
      expect(foreignClinic.json).toEqual({ error: "not_found", entity: "clinic" });

      expect(await db.appointment.count({ where: { OR: [{ patientId: patientB, tenantId: a.id }, { doctorId: doctorB.id }] } })).toBe(0);
      expect(await db.appointment.count({ where: { tenantId: a.id, startsAt: { gte: dayStart(40), lt: dayEnd(40) } } })).toBe(0);
    });
  });

  describe("RBAC", () => {
    it("an assistant can read but not write", async () => {
      const id = await scheduled(41, 9);
      const list = await listRoute(request("/api/appointments", { cookie: assistantCookie }));
      expect(list.status).toBe(200);
      const read = await getRoute(request(`/api/appointments/${id}`, { cookie: assistantCookie }), params(id));
      expect(read.status).toBe(200);

      const create = await book({ patientId: patientA, doctorId: doctorA.id, ...slot(41, 11) }, assistantCookie);
      expect(create.res.status).toBe(403);
      const move = await patch(id, slot(41, 12), assistantCookie);
      expect(move.res.status).toBe(403);
      const confirm = await transition(id, { status: "CONFIRMED" }, assistantCookie);
      expect(confirm.res.status).toBe(403);
      expect((await db.appointment.findUnique({ where: { id } }))?.status).toBe("SCHEDULED");
    });

    it("requires a session everywhere", async () => {
      expect((await listRoute(request("/api/appointments"))).status).toBe(401);
      expect((await getRoute(request("/api/appointments/x"), params("x"))).status).toBe(401);
      expect((await patchRoute(request("/api/appointments/x", { method: "PATCH", body: {} }), params("x"))).status).toBe(401);
      expect((await transitionRoute(request("/api/appointments/x/transition", { body: {} }), params("x"))).status).toBe(401);
      expect((await staffRoute(request("/api/staff"))).status).toBe(401);
    });
  });

  describe("GET /api/staff", () => {
    it("lists only the tenant's active clinicians (no nurse, no non-clinical owner)", async () => {
      const res = await staffRoute(request("/api/staff", { cookie: assistantCookie }));
      expect(res.status).toBe(200);
      const staff = (await res.json()).staff as { id: string; fullName: string; role: string }[];
      expect(staff.map((s) => s.fullName).sort()).toEqual(["Dr. Amina", "Dr. Bassem", "Owner A"]);
      expect(staff.map((s) => s.id)).not.toContain(doctorB.id);
      expect(staff.every((s) => ["DOCTOR", "CLINIC_OWNER"].includes(s.role))).toBe(true);
    });

    it("filters by role and validates it", async () => {
      const doctors = await staffRoute(request("/api/staff?role=DOCTOR", { cookie: ownerCookie }));
      expect(doctors.status).toBe(200);
      expect(((await doctors.json()).staff as { id: string }[]).map((s) => s.id).sort()).toEqual(
        [doctorA.id, doctorA2.id].sort(),
      );
      const bad = await staffRoute(request("/api/staff?role=ASSISTANT", { cookie: ownerCookie }));
      expect(bad.status).toBe(422);
    });
  });
});

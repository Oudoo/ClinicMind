/**
 * No double bookings, the free-slot search and the "next appointment" button,
 * over the real route handlers and the test database: working hours and
 * Friday closing, the doctor's and the room's taken slots, suggestions after
 * a time, the patient-overlap rule (and why a waitlisted booking escapes it),
 * the exclusion constraints underneath, GET /api/appointments/next per role
 * and the late-flag job. The slot grid and the countdown are unit-tested
 * without the database first.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mailer", () => ({ sendMail: vi.fn(async () => undefined) }));

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { dateKeyInTz } from "@/lib/time";
import { updateTenantSettings } from "@/lib/tenant-settings";
import { POST as createRoute } from "@/app/api/appointments/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { GET as freeSlotsRoute } from "@/app/api/appointments/free-slots/route";
import { GET as nextRoute } from "@/app/api/appointments/next/route";
import { isExclusionViolation } from "@/modules/appointments/service";
import { buildSlotGrid, freeCellsAfter, normaliseHours, type TakenRange } from "@/modules/appointments/slots";
import { DEFAULT_WORKING_HOURS } from "@/modules/appointments/transitions";
import { describeCountdown, isRunningLate } from "@/modules/appointments/countdown";
import { flagLateAppointments, jobs, LATE_FLAG_JOB } from "@/modules/appointments/jobs";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const TZ = "Africa/Cairo";
const MIN = 60_000;
// January 2030: Cairo runs on UTC+2 (no daylight saving in winter).
const THU = "2030-01-10";
const FRI = "2030-01-11";
const SAT = "2030-01-12";
const SUN = "2030-01-13";
/** An instant on the clinic clock. */
const at = (date: string, time: string) => new Date(`${date}T${time}:00+02:00`);
const iso = (date: string, time: string) => at(date, time).toISOString();

type Cell = { startsAt: string; free: boolean; past: boolean; takenBy: { id: string; patientInitials: string; patientName: string; room: string | null; status: string }[] };
type Slots = { date: string; closed: boolean; hours: unknown; slots: Cell[]; free: string[]; suggestions: { startsAt: string; date: string }[] };

describe("slot grid and countdown (pure)", () => {
  const taken = (from: string, to: string, extra: Partial<TakenRange> = {}): TakenRange => ({
    id: `${from}-${to}`,
    startsAt: at(SUN, from),
    endsAt: at(SUN, to),
    status: "SCHEDULED",
    doctorId: "d1",
    room: null,
    patientId: "p1",
    patientName: "Mona Adel",
    patientInitials: "MA",
    ...extra,
  });

  it("repairs the stored working hours field by field", () => {
    expect(normaliseHours(undefined)).toEqual(DEFAULT_WORKING_HOURS);
    expect(normaliseHours({ days: [1, 9, 1, "x"], start: "25:00", end: "18:00" })).toEqual({ days: [1], start: "10:00", end: "18:00" });
    expect(normaliseHours({ start: "19:00", end: "09:00" })).toEqual(DEFAULT_WORKING_HOURS);
    expect(normaliseHours({ days: [], start: "08:30", end: "14:00" })).toEqual({ days: DEFAULT_WORKING_HOURS.days, start: "08:30", end: "14:00" });
  });

  it("lays the day out on a 15-minute grid inside the hours; Friday is closed by default", () => {
    const grid = buildSlotGrid({ day: at(SUN, "12:00"), timeZone: TZ, hours: DEFAULT_WORKING_HOURS, durationMinutes: 30, taken: [] });
    expect(grid.closed).toBe(false);
    expect(grid.cells).toHaveLength(39);
    expect(grid.cells[0]!.startsAt.toISOString()).toBe(iso(SUN, "10:00"));
    expect(grid.cells.at(-1)!.startsAt.toISOString()).toBe(iso(SUN, "19:30"));
    expect(grid.cells.at(-1)!.endsAt.toISOString()).toBe(iso(SUN, "20:00"));
    expect(buildSlotGrid({ day: at(FRI, "12:00"), timeZone: TZ, hours: DEFAULT_WORKING_HOURS, durationMinutes: 30, taken: [] })).toEqual({ closed: true, cells: [] });
  });

  it("marks overlapping cells taken (back-to-back is free) and earlier cells past", () => {
    const grid = buildSlotGrid({
      day: at(SUN, "08:00"),
      timeZone: TZ,
      hours: DEFAULT_WORKING_HOURS,
      durationMinutes: 30,
      taken: [taken("11:00", "12:00")],
      notBefore: at(SUN, "10:20"),
    });
    const cell = (time: string) => grid.cells.find((c) => c.startsAt.toISOString() === iso(SUN, time))!;
    expect(cell("10:00")).toMatchObject({ past: true, free: false });
    expect(cell("10:30")).toMatchObject({ past: false, free: true });
    expect(cell("10:45")).toMatchObject({ free: false });
    expect(cell("10:45").takenBy[0]!.patientInitials).toBe("MA");
    expect(cell("11:45").free).toBe(false);
    expect(cell("12:00").free).toBe(true);
    expect(freeCellsAfter(grid.cells, at(SUN, "10:30"), 3).map((c) => c.startsAt.toISOString())).toEqual([iso(SUN, "12:00"), iso(SUN, "12:15"), iso(SUN, "12:30")]);
  });

  it("words the countdown and flags lateness at the documented boundaries", () => {
    const now = at(SUN, "10:00");
    const slot = (startOffsetMin: number, status: "SCHEDULED" | "CONFIRMED" | "CHECKED_IN" | "IN_PROGRESS" | "COMPLETED") => ({
      startsAt: new Date(now.getTime() + startOffsetMin * MIN),
      endsAt: new Date(now.getTime() + (startOffsetMin + 30) * MIN),
      status,
    });
    expect(describeCountdown(slot(12, "SCHEDULED"), now)).toMatchObject({ label: "starts in 12 min", tone: "accent", late: false, minutesToStart: 12 });
    expect(describeCountdown(slot(125, "CONFIRMED"), now)).toMatchObject({ label: "starts in 2 h 05 min", tone: "default", late: false });
    expect(describeCountdown(slot(0, "CONFIRMED"), now).label).toBe("starting now");
    expect(describeCountdown(slot(-3, "SCHEDULED"), now)).toMatchObject({ label: "started 3 min ago · not checked in", tone: "warning", late: true });
    expect(describeCountdown(slot(-40, "CONFIRMED"), now).label).toBe("started 40 min ago · not checked in · slot over");
    expect(describeCountdown(slot(-5, "CHECKED_IN"), now)).toMatchObject({ label: "checked in · started 5 min ago", tone: "success", late: false });
    expect(describeCountdown(slot(-12, "CHECKED_IN"), now)).toMatchObject({ label: "running late · waiting 12 min", tone: "danger", late: true });
    expect(describeCountdown(slot(-7, "IN_PROGRESS"), now)).toMatchObject({ label: "in consultation · started 7 min ago", tone: "accent", late: false });
    expect(describeCountdown(slot(-60, "COMPLETED"), now).label).toBe("completed");
    expect(isRunningLate(slot(-0.5, "CONFIRMED"), now)).toBe(false);
    expect(isRunningLate(slot(-1, "CONFIRMED"), now)).toBe(true);
    expect(isRunningLate(slot(-9, "CHECKED_IN"), now)).toBe(false);
    expect(isRunningLate(slot(-10, "CHECKED_IN"), now)).toBe(true);
  });
});

describe.skipIf(!dbTestsEnabled)("free slots, double-booking protection, next appointment and the late flag", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let c: string;
  let desk: { id: string };
  let d1: { id: string };
  let d2: { id: string };
  let d3: { id: string };
  let d4: { id: string };
  let doctorB: { id: string };
  let doctorC: { id: string };
  let ownerCookie: string;
  let deskCookie: string;
  let assistantCookie: string;
  let d1Cookie: string;
  let d3Cookie: string;
  let ownerBCookie: string;
  let ownerCCookie: string;
  const P = { mona: "", ramy: "", sherif: "", laila: "" };
  let patientB: string;
  const booked: Record<string, string> = {};

  async function book(body: Record<string, unknown>, cookie = deskCookie) {
    const res = await createRoute(request("/api/appointments", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  }

  async function slots(qs: string, cookie = deskCookie) {
    const res = await freeSlotsRoute(request(`/api/appointments/free-slots?${qs}`, { cookie }));
    return { res, json: (await res.json()) as Slots };
  }

  async function next(qs = "", cookie = deskCookie) {
    const res = await nextRoute(request(`/api/appointments/next${qs ? `?${qs}` : ""}`, { cookie }));
    return { res, json: await res.json() };
  }

  const cellAt = (data: Slots, date: string, time: string) => data.slots.find((s) => s.startsAt === iso(date, time))!;

  beforeAll(async () => {
    const stamp = Date.now().toString(36);
    const tenantA = await createTenant({ slug: `slots-a-${stamp}` });
    const tenantB = await createTenant({ slug: `slots-b-${stamp}` });
    const tenantC = await createTenant({ slug: `slots-c-${stamp}` });
    created.push(tenantA.id, tenantB.id, tenantC.id);
    a = tenantA.id;
    b = tenantB.id;
    c = tenantC.id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    desk = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    d1 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Hana" });
    d2 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Karim" });
    d3 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Free" });
    d4 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Late" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorB = await createUser({ tenantId: b, role: "DOCTOR", fullName: "Dr. Beta" });
    const ownerC = await createUser({ tenantId: c, role: "CLINIC_OWNER", fullName: "Owner C" });
    doctorC = await createUser({ tenantId: c, role: "DOCTOR", fullName: "Dr. Gamma" });
    ownerCookie = await sessionCookieFor(owner.id);
    deskCookie = await sessionCookieFor(desk.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    d1Cookie = await sessionCookieFor(d1.id);
    d3Cookie = await sessionCookieFor(d3.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    ownerCCookie = await sessionCookieFor(ownerC.id);
    for (const [key, fullName] of [["mona", "Mona Adel"], ["ramy", "Ramy Fawzy"], ["sherif", "Sherif Gamal"], ["laila", "Laila Nabil"]] as const) {
      P[key] = (await db.patient.create({ data: { tenantId: a, fullName } })).id;
    }
    patientB = (await db.patient.create({ data: { tenantId: b, fullName: "Patient Of B" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("free slots", () => {
    it("respect the working hours: Saturday to Thursday 10:00–20:00 on the clinic clock", async () => {
      const { res, json } = await slots(`doctorId=${d1.id}&date=${SUN}&duration=30`);
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ date: SUN, closed: false, hours: DEFAULT_WORKING_HOURS, timezone: TZ, stepMinutes: 15, durationMinutes: 30 });
      expect(json.slots).toHaveLength(39);
      expect(json.slots[0]!.startsAt).toBe(iso(SUN, "10:00"));
      expect(json.slots.at(-1)!.startsAt).toBe(iso(SUN, "19:30"));
      expect(json.free).toHaveLength(39);
      expect(json.suggestions).toEqual([
        { startsAt: iso(SUN, "10:00"), endsAt: iso(SUN, "10:30"), date: SUN },
        { startsAt: iso(SUN, "10:15"), endsAt: iso(SUN, "10:45"), date: SUN },
        { startsAt: iso(SUN, "10:30"), endsAt: iso(SUN, "11:00"), date: SUN },
      ]);
      const hour = await slots(`doctorId=${d1.id}&date=${SUN}&duration=60`);
      expect(hour.json.slots).toHaveLength(37);
      expect(hour.json.slots.at(-1)!.startsAt).toBe(iso(SUN, "19:00"));
    });

    it("are closed on Friday by default, and suggest Saturday instead", async () => {
      const { json } = await slots(`doctorId=${d1.id}&date=${FRI}`);
      expect(json).toMatchObject({ closed: true, slots: [], free: [] });
      expect(json.suggestions.map((s) => [s.date, s.startsAt])).toEqual([
        [SAT, iso(SAT, "10:00")],
        [SAT, iso(SAT, "10:15")],
        [SAT, iso(SAT, "10:30")],
      ]);
    });

    it("follow the tenant's own hours setting", async () => {
      await updateTenantSettings(c, { hours: { days: [5], start: "09:00", end: "11:00" } });
      const fri = await slots(`doctorId=${doctorC.id}&date=${FRI}&duration=30`, ownerCCookie);
      expect(fri.json.closed).toBe(false);
      expect(fri.json.slots.map((s) => s.startsAt)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00", "10:15", "10:30"].map((t) => iso(FRI, t)));
      expect((await slots(`doctorId=${doctorC.id}&date=${SAT}`, ownerCCookie)).json.closed).toBe(true);
    });

    it("leave out the doctor's live bookings (cancelled ones free their slot, other doctors' do not count)", async () => {
      booked.mona1000 = (await book({ patientId: P.mona, doctorId: d1.id, startsAt: iso(SUN, "10:00"), endsAt: iso(SUN, "10:30") })).json.appointment.id;
      booked.ramy1100 = (await book({ patientId: P.ramy, doctorId: d1.id, startsAt: iso(SUN, "11:00"), endsAt: iso(SUN, "12:00") })).json.appointment.id;
      const cancelled = (await book({ patientId: P.sherif, doctorId: d1.id, startsAt: iso(SUN, "13:00"), endsAt: iso(SUN, "13:30") })).json.appointment.id;
      const cancel = await transitionRoute(
        request(`/api/appointments/${cancelled}/transition`, { method: "POST", cookie: deskCookie, body: { status: "CANCELLED", reason: "Patient travelling" } }),
        { params: Promise.resolve({ id: cancelled }) },
      );
      expect(cancel.status).toBe(200);
      booked.sherif1400 = (await book({ patientId: P.sherif, doctorId: d2.id, room: "Room 7", startsAt: iso(SUN, "14:00"), endsAt: iso(SUN, "15:00") })).json.appointment.id;

      const { json } = await slots(`doctorId=${d1.id}&date=${SUN}&duration=30`);
      expect(cellAt(json, SUN, "10:00")).toMatchObject({ free: false, takenBy: [{ id: booked.mona1000, patientInitials: "MA", patientName: "Mona Adel", status: "SCHEDULED" }] });
      expect(cellAt(json, SUN, "10:15").free).toBe(false);
      expect(cellAt(json, SUN, "10:30").free).toBe(true);
      expect(cellAt(json, SUN, "10:45")).toMatchObject({ free: false, takenBy: [{ id: booked.ramy1100 }] });
      expect(cellAt(json, SUN, "11:45").free).toBe(false);
      expect(cellAt(json, SUN, "12:00").free).toBe(true);
      expect(cellAt(json, SUN, "13:00").free).toBe(true);
      expect(cellAt(json, SUN, "14:00").free).toBe(true);
      expect(json.free).toHaveLength(39 - 2 - 5);
    });

    it("leave out the room's bookings whoever the doctor is, and a room alone can be searched", async () => {
      const withRoom = await slots(`doctorId=${d1.id}&room=${encodeURIComponent("Room 7")}&date=${SUN}`);
      expect(cellAt(withRoom.json, SUN, "13:45").free).toBe(false);
      expect(cellAt(withRoom.json, SUN, "14:00")).toMatchObject({ free: false, takenBy: [{ id: booked.sherif1400, room: "Room 7" }] });
      expect(cellAt(withRoom.json, SUN, "15:00").free).toBe(true);
      // Doctor 1's own bookings still count.
      expect(cellAt(withRoom.json, SUN, "10:00").free).toBe(false);
      const roomOnly = await slots(`room=${encodeURIComponent("Room 7")}&date=${SUN}`);
      expect(roomOnly.res.status).toBe(200);
      expect(cellAt(roomOnly.json, SUN, "10:00").free).toBe(true);
      expect(cellAt(roomOnly.json, SUN, "14:30").free).toBe(false);
    });

    it("suggest the next free starts strictly after a given time", async () => {
      const { json } = await slots(`doctorId=${d1.id}&date=${SUN}&after=${encodeURIComponent(iso(SUN, "10:00"))}`);
      expect(json.suggestions.map((s) => s.startsAt)).toEqual([iso(SUN, "10:30"), iso(SUN, "12:00"), iso(SUN, "12:15")]);
    });

    it("look ahead past a closed Friday when the day has nothing left", async () => {
      const { json } = await slots(`doctorId=${d1.id}&date=${THU}&after=${encodeURIComponent(iso(THU, "19:30"))}`);
      expect(json.closed).toBe(false);
      expect(json.suggestions.map((s) => [s.date, s.startsAt])).toEqual([
        [SAT, iso(SAT, "10:00")],
        [SAT, iso(SAT, "10:15")],
        [SAT, iso(SAT, "10:30")],
      ]);
    });

    it("do not let the appointment being rescheduled block its own slot", async () => {
      const { json } = await slots(`doctorId=${d1.id}&date=${SUN}&excludeId=${booked.ramy1100}`);
      expect(cellAt(json, SUN, "11:00").free).toBe(true);
      expect(cellAt(json, SUN, "10:00").free).toBe(false);
    });

    it("never offer a slot in the past", async () => {
      const { json } = await slots(`doctorId=${d1.id}&date=2020-01-05`);
      expect(json.closed).toBe(false);
      expect(json.free).toEqual([]);
      expect(json.slots.every((s) => s.past && !s.free)).toBe(true);
    });

    it("validate the query, scope the doctor to the tenant and allow read-only staff", async () => {
      for (const qs of [`doctorId=${d1.id}&date=2030-02-30`, `doctorId=${d1.id}&date=tomorrow`, `doctorId=${d1.id}&date=${SUN}&duration=3`, `doctorId=${d1.id}&date=${SUN}&duration=481`, `date=${SUN}`]) {
        expect((await slots(qs)).res.status, qs).toBe(422);
      }
      expect((await slots(`doctorId=${doctorB.id}&date=${SUN}`)).res.status).toBe(404);
      expect((await slots(`doctorId=${d1.id}&date=${SUN}`, assistantCookie)).res.status).toBe(200);
      expect((await freeSlotsRoute(request(`/api/appointments/free-slots?doctorId=${d1.id}&date=${SUN}`))).status).toBe(401);
    });
  });

  describe("double-booking protection", () => {
    it("refuses the doctor's taken slot with 409 and the booking in the way, and tells the actor", async () => {
      const { res, json } = await book({ patientId: P.laila, doctorId: d1.id, startsAt: iso(SUN, "10:15"), endsAt: iso(SUN, "10:45") });
      expect(res.status).toBe(409);
      expect(json.error).toBe("conflict");
      expect(json.conflicts.map((x: { id: string }) => x.id)).toEqual([booked.mona1000]);
      await vi.waitFor(
        async () => {
          const n = await db.notification.findFirst({ where: { tenantId: a, userId: desk.id, kind: "BOOKING_CONFLICT" } });
          expect(n).toMatchObject({ level: "WARNING", title: "Double booking refused" });
        },
        { timeout: 3000, interval: 50 },
      );
    });

    it("refuses a patient's overlapping live booking with another doctor (409 patient_conflict) unless allowed", async () => {
      const refused = await book({ patientId: P.mona, doctorId: d2.id, startsAt: iso(SUN, "10:15"), endsAt: iso(SUN, "10:45") });
      expect(refused.res.status).toBe(409);
      expect(refused.json.error).toBe("patient_conflict");
      expect(refused.json.conflicts).toMatchObject([{ id: booked.mona1000, patient: { id: P.mona }, doctor: { id: d1.id, fullName: "Dr. Hana" } }]);
      expect(await db.appointment.count({ where: { tenantId: a, patientId: P.mona, doctorId: d2.id } })).toBe(0);

      const allowed = await book({ patientId: P.mona, doctorId: d2.id, startsAt: iso(SUN, "10:15"), endsAt: iso(SUN, "10:45"), allowPatientOverlap: true });
      expect(allowed.res.status).toBe(201);
      expect(allowed.json.appointment.status).toBe("SCHEDULED");
    });

    it("a waitlisted booking holds no slot, so it does not trigger the patient rule; promoting it does", async () => {
      // Doctor 2 is taken at 11:00 by Laila; Ramy is already live with doctor 1 at 11:00.
      const laila = await book({ patientId: P.laila, doctorId: d2.id, startsAt: iso(SUN, "11:00"), endsAt: iso(SUN, "11:30") });
      expect(laila.res.status).toBe(201);
      const plain = await book({ patientId: P.ramy, doctorId: d2.id, startsAt: iso(SUN, "11:00"), endsAt: iso(SUN, "11:30") });
      expect(plain.res.status).toBe(409);
      expect(plain.json.error).toBe("conflict");
      const waitlisted = await book({ patientId: P.ramy, doctorId: d2.id, startsAt: iso(SUN, "11:00"), endsAt: iso(SUN, "11:30"), allowWaitlist: true });
      expect(waitlisted.res.status).toBe(201);
      expect(waitlisted.json.appointment.status).toBe("WAITLISTED");

      // Laila cancels: the slot is free, but Ramy cannot be in two places at once.
      const transition = (id: string, body: Record<string, unknown>) =>
        transitionRoute(request(`/api/appointments/${id}/transition`, { method: "POST", cookie: deskCookie, body }), { params: Promise.resolve({ id }) });
      expect((await transition(laila.json.appointment.id, { status: "CANCELLED", reason: "Rescheduled by phone" })).status).toBe(200);
      const promote = await transition(waitlisted.json.appointment.id, { status: "SCHEDULED" });
      expect(promote.status).toBe(409);
      expect((await promote.json()).error).toBe("patient_conflict");
    });

    it("the database itself refuses an overlapping live booking of the same doctor, whoever writes it", async () => {
      const raw = (data: { doctorId?: string | null; room?: string | null; status?: "SCHEDULED" | "CANCELLED" | "WAITLISTED" | "NO_SHOW"; from: string; to: string; tenantId?: string; patientId?: string }) =>
        db.appointment.create({
          data: {
            tenantId: data.tenantId ?? a,
            patientId: data.patientId ?? P.sherif,
            doctorId: data.doctorId ?? null,
            room: data.room ?? null,
            status: data.status ?? "SCHEDULED",
            startsAt: at(SUN, data.from),
            endsAt: at(SUN, data.to),
          },
        });

      const doctorClash = await raw({ doctorId: d1.id, from: "10:10", to: "10:40" }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(doctorClash).not.toBeNull();
      expect(isExclusionViolation(doctorClash)).toBe(true);
      expect(String((doctorClash as Error).message)).toMatch(/appointments_doctor_no_overlap|23P01|exclusion/i);

      // The same room, another doctor: refused by the room constraint.
      const roomClash = await raw({ doctorId: d3.id, room: "Room 7", from: "14:30", to: "15:00" }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(isExclusionViolation(roomClash)).toBe(true);

      // Rows that hold no slot, back-to-back slots and another clinic's room of the same name are fine.
      await expect(raw({ doctorId: d1.id, status: "CANCELLED", from: "10:00", to: "10:30" })).resolves.toBeTruthy();
      await expect(raw({ doctorId: d1.id, status: "WAITLISTED", from: "10:00", to: "10:30" })).resolves.toBeTruthy();
      await expect(raw({ doctorId: d1.id, from: "10:30", to: "10:45" })).resolves.toBeTruthy();
      await expect(raw({ tenantId: b, patientId: patientB, doctorId: doctorB.id, room: "Room 7", from: "14:00", to: "15:00" })).resolves.toBeTruthy();
      expect(await db.appointment.count({ where: { tenantId: a, doctorId: d1.id, startsAt: at(SUN, "10:10") } })).toBe(0);
    });
  });

  describe("GET /api/appointments/next", () => {
    let d1Next: string;
    let d2Next: string;

    beforeAll(async () => {
      const now = Date.now();
      d1Next = (
        await db.appointment.create({
          data: { tenantId: a, patientId: P.mona, doctorId: d1.id, status: "CONFIRMED", startsAt: new Date(now + 180 * MIN), endsAt: new Date(now + 210 * MIN) },
        })
      ).id;
      d2Next = (
        await db.appointment.create({
          data: { tenantId: a, patientId: P.sherif, doctorId: d2.id, status: "SCHEDULED", startsAt: new Date(now + 60 * MIN), endsAt: new Date(now + 90 * MIN), reason: "Acne follow-up" },
        })
      ).id;
    });

    it("gives a doctor their own next appointment", async () => {
      const { res, json } = await next("", d1Cookie);
      expect(res.status).toBe(200);
      expect(json).toMatchObject({ scope: "mine", fallback: false, timezone: TZ, appointment: { id: d1Next, status: "CONFIRMED", patient: { fullName: "Mona Adel" }, doctor: { id: d1.id } } });
      expect(Number.isNaN(Date.parse(json.now))).toBe(false);
      expect(json.queue.map((q: { id: string }) => q.id)).not.toContain(d1Next);
    });

    it("gives reception the clinic's next appointment and the rest of today's queue", async () => {
      const { json } = await next();
      expect(json).toMatchObject({ scope: "clinic", fallback: false, appointment: { id: d2Next, reason: "Acne follow-up", doctor: { fullName: "Dr. Karim" } } });
      const later = new Date(Date.now() + 180 * MIN);
      if (dateKeyInTz(later, TZ) === dateKeyInTz(new Date(), TZ)) {
        expect(json.queue.map((q: { id: string }) => q.id)).toContain(d1Next);
      }
      expect(json.queue.map((q: { id: string }) => q.id)).not.toContain(d2Next);
    });

    it("falls back to the clinic's next for a doctor with nothing booked, and honours an explicit scope", async () => {
      expect((await next("", d3Cookie)).json).toMatchObject({ scope: "clinic", fallback: true, appointment: { id: d2Next } });
      expect((await next("scope=clinic", d1Cookie)).json).toMatchObject({ scope: "clinic", appointment: { id: d2Next } });
      expect((await next("scope=mine", d3Cookie)).json).toMatchObject({ scope: "mine", appointment: null, queue: [] });
      expect((await next("", assistantCookie)).json).toMatchObject({ scope: "clinic", appointment: { id: d2Next } });
      expect((await next("", ownerCookie)).json).toMatchObject({ scope: "clinic", fallback: true });
    });

    it("gives one patient's next appointment and the ones after it, and 404s another tenant's patient", async () => {
      const { json } = await next(`patientId=${P.mona}`);
      expect(json).toMatchObject({ scope: "patient", appointment: { id: d1Next } });
      expect(json.queue.map((q: { id: string }) => q.id)).toEqual(expect.arrayContaining([booked.mona1000]));
      expect((await next(`patientId=${patientB}`)).res.status).toBe(404);
      expect((await next("scope=everyone")).res.status).toBe(422);
      // Tenant B's owner only ever sees tenant B's bookings.
      const other = (await next("", ownerBCookie)).json;
      expect([d1Next, d2Next, booked.mona1000]).not.toContain(other.appointment?.id);
      expect(other.appointment?.patientId ?? patientB).toBe(patientB);
      expect((await nextRoute(request("/api/appointments/next"))).status).toBe(401);
    });
  });

  describe("late flag job", () => {
    it(`is registered as "${LATE_FLAG_JOB}" every 5 minutes`, () => {
      expect(jobs.map((j) => [j.name, j.everyMinutes])).toEqual([[LATE_FLAG_JOB, 5]]);
    });

    it("notifies reception and the doctor once when a booking is 20+ minutes past its start without a check-in", async () => {
      const now = Date.now();
      const row = (data: { doctorId?: string; patientId: string; status: "SCHEDULED" | "CONFIRMED" | "CANCELLED"; from: number; to: number; checkedInAt?: Date; lateFlaggedAt?: Date }) =>
        db.appointment.create({
          data: {
            tenantId: a,
            patientId: data.patientId,
            doctorId: data.doctorId ?? null,
            status: data.status,
            startsAt: new Date(now + data.from * MIN),
            endsAt: new Date(now + data.to * MIN),
            checkedInAt: data.checkedInAt ?? null,
            lateFlaggedAt: data.lateFlaggedAt ?? null,
          },
        });
      const late = await row({ doctorId: d4.id, patientId: P.laila, status: "CONFIRMED", from: -25, to: -1 });
      const early = await row({ patientId: P.ramy, status: "SCHEDULED", from: -10, to: -2 });
      const checkedIn = await row({ patientId: P.sherif, status: "CONFIRMED", from: -40, to: -35, checkedInAt: new Date(now - 41 * MIN) });
      const old = await row({ patientId: P.ramy, status: "SCHEDULED", from: -30 * 60, to: -30 * 60 + 30 });
      const flaggedBefore = await row({ patientId: P.sherif, status: "SCHEDULED", from: -50, to: -45, lateFlaggedAt: new Date(now - 20 * MIN) });
      const cancelled = await row({ patientId: P.ramy, status: "CANCELLED", from: -60, to: -55 });

      const first = await flagLateAppointments(new Date());
      expect(first.flagged).toBeGreaterThanOrEqual(1);
      const notes = await db.notification.findMany({ where: { tenantId: a, kind: "NO_SHOW" } });
      expect(notes.map((n) => n.userId).sort()).toEqual([desk.id, d4.id].sort());
      for (const n of notes) {
        expect(n).toMatchObject({
          level: "WARNING",
          title: "Laila Nabil has not checked in",
          href: `/dashboard/appointments?date=${dateKeyInTz(late.startsAt, TZ)}&view=day`,
          entity: "Appointment",
          entityId: late.id,
        });
        expect(n.body).toContain("with Dr. Late");
        expect(n.body).toMatch(/2[56] min past the start/);
      }

      const stamped = await db.appointment.findMany({ where: { id: { in: [late.id, early.id, checkedIn.id, old.id, flaggedBefore.id, cancelled.id] } } });
      const stamp = Object.fromEntries(stamped.map((s) => [s.id, s.lateFlaggedAt]));
      expect(stamp[late.id]).not.toBeNull();
      for (const id of [early.id, checkedIn.id, old.id, cancelled.id]) expect(stamp[id]).toBeNull();
      expect(stamp[flaggedBefore.id]?.getTime()).toBe(now - 20 * MIN);

      // Idempotent: the next runs (and the job wrapper) notify nobody again.
      await flagLateAppointments(new Date());
      const summary = await jobs[0]!.run({ now: new Date(), log: () => undefined });
      expect(summary).toMatch(/late appointment\(s\) flagged across \d+ tenant\(s\)/);
      expect(await db.notification.count({ where: { tenantId: a, kind: "NO_SHOW" } })).toBe(2);
    });
  });
});

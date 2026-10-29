/**
 * Phase 3E/3F over the real route handlers and the test database: the recalls
 * shown with a patient's next visit (what it is booked for, what else is due
 * by then); the recall dashboard (the recalls due in a period: contacted,
 * booked, booked within 30 days, by kind; accepted treatment not booked;
 * lapsed patients won back; revenue from recalls for the finance roles only;
 * how recalls ended; each person's part), against the period before; and
 * every recall ending: one left waiting long after its window is ended as
 * unreachable by the sweep.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, endOfDayInTz, startOfDayInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { sweepRecalls } from "@/modules/recalls/engine";
import { GET as nextRoute } from "@/app/api/appointments/next/route";
import { GET as resultsRoute } from "@/app/api/recalls/results/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const cairo = (year: number, month: number, day: number, hour = 0, minute = 0) => zonedTimeToUtc({ year, month, day, hour, minute }, TZ);
const json = async (res: Response) => ({ status: res.status, json: await res.json() });

describe.skipIf(!dbTestsEnabled)("recall panel, results and endings", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let receptionId: string;
  let doctorId: string;
  let treatmentId: string;
  let keys = 0;

  const patient = async (fullName: string, tenantId = a) => (await db.patient.create({ data: { tenantId, fullName, phone: "+201001112233", whatsapp: "+201001112233" } })).id;
  async function recall(patientId: string, dueAt: Date, extra: Partial<Prisma.RecallUncheckedCreateInput> = {}) {
    keys += 1;
    return db.recall.create({ data: { tenantId: a, patientId, kind: "REVIEW", label: `Review ${keys}`, dueAt, windowEndAt: endOfDayInTz(addDays(dueAt, 14, TZ), TZ), dedupeKey: `test:${keys}`, ...extra } });
  }
  const visit = (patientId: string, startsAt: Date, status: "SCHEDULED" | "COMPLETED" = "SCHEDULED") =>
    db.appointment.create({ data: { tenantId: a, patientId, doctorId, startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), status, statusChangedAt: startsAt } });
  const log = (recallId: string, kind: "CALL" | "MESSAGE" | "STATUS", at: Date, byId: string | null, outcome = kind === "CALL" ? "no_answer" : "LOGGED") =>
    db.recallActivity.create({ data: { tenantId: a, recallId, kind, outcome, byId, at } });
  /** The first day from `n` days ahead the clinic is open (not a Friday), at `hour`. */
  const openDay = (n: number, hour: number) => {
    for (let d = n; d < n + 7; d += 1) {
      const p = zonedParts(addDays(new Date(), d, TZ), TZ);
      if (p.weekday !== 5) return cairo(p.year, p.month, p.day, hour);
    }
    throw new Error("no open day");
  };

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `recall-res-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `recall-res-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Recall" });
    receptionId = reception.id;
    doctorId = doctor.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    await ensureDefaultTreatments(a);
    treatmentId = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "prp-hair" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("the next-appointment card carries what the visit is booked for, then what else is due by then", async () => {
    const p = await patient("Nadia Farouk");
    const at = openDay(5, 11);
    const next = await visit(p, at);
    const booked = await recall(p, startOfDayInTz(at, TZ), { status: "BOOKED", bookedAppointmentId: next.id, bookedAt: new Date(), label: "Hair transplant · 1-month review" });
    const alsoDue = await recall(p, startOfDayInTz(addDays(at, 3, TZ), TZ), { kind: "NEXT_SESSION", stage: 2, label: "PRP · session 2" });
    await recall(p, startOfDayInTz(addDays(at, 30, TZ), TZ), { label: "Too far ahead" });
    await recall(p, startOfDayInTz(at, TZ), { status: "DONE", closedAt: new Date(), label: "Ended already" });

    const res = await json(await nextRoute(request(`/api/appointments/next?patientId=${p}`, { cookie: receptionCookie })));
    expect(res.status).toBe(200);
    expect(res.json.appointment.id).toBe(next.id);
    expect(res.json.recalls).toEqual([
      expect.objectContaining({ id: booked.id, label: "Hair transplant · 1-month review", kindLabel: "Review", thisVisit: true, band: "booked" }),
      expect.objectContaining({ id: alsoDue.id, label: "PRP · session 2", thisVisit: false, band: "soon", bandLabel: expect.stringMatching(/^Due in \d+ days$/) }),
    ]);
    // Every role that reads appointments reads recalls too.
    expect((await json(await nextRoute(request(`/api/appointments/next?patientId=${p}`, { cookie: assistantCookie })))).json.recalls).toHaveLength(2);
    // Nothing booked: no recalls to show with it.
    const none = await json(await nextRoute(request(`/api/appointments/next?patientId=${await patient("Nobody Booked")}`, { cookie: receptionCookie })));
    expect(none.json.appointment).toBeNull();
    expect(none.json.recalls).toBeUndefined();
  });

  it("the dashboard: the recalls due in the period, contacted, booked, within 30 days, by kind; not booked; won back; revenue; endings; each person's part", async () => {
    const p = await patient("Results Patient");
    const charge = (data: Partial<Prisma.ChargeUncheckedCreateInput> & { amount: number; chargedAt: Date }) => db.charge.create({ data: { tenantId: a, patientId: p, description: "Work", ...data } });
    // August 2026, against July.
    const a1 = await recall(p, cairo(2026, 8, 5), { status: "BOOKED", bookedAt: cairo(2026, 8, 6, 12), bookedById: receptionId, bookedAppointmentId: "visit-ahead" });
    await log(a1.id, "CALL", cairo(2026, 8, 4, 11), receptionId, "will_book");
    const v2 = await visit(p, cairo(2026, 9, 20, 11), "COMPLETED");
    const a2 = await recall(p, cairo(2026, 8, 10), { status: "DONE", closedAt: cairo(2026, 9, 20, 11, 30), doneAppointmentId: v2.id });
    await log(a2.id, "MESSAGE", cairo(2026, 8, 10, 10), null);
    const v3 = await visit(p, cairo(2026, 8, 14, 11), "COMPLETED");
    await recall(p, cairo(2026, 8, 12), { kind: "NEXT_SESSION", stage: 2, status: "DONE", closedAt: cairo(2026, 8, 14, 11, 30), doneAppointmentId: v3.id });
    await charge({ amount: 1_800, chargedAt: cairo(2026, 8, 14, 11), appointmentId: v3.id });
    await db.payment.create({ data: { tenantId: a, patientId: p, kind: "CONSULTATION_FEE", amount: 300, paidAt: cairo(2026, 8, 14, 11), appointmentId: v3.id } });
    await recall(p, cairo(2026, 8, 20), { kind: "MISSED" });
    const v5 = await visit(p, cairo(2026, 8, 28, 12), "COMPLETED");
    await recall(p, cairo(2026, 8, 25), { kind: "LAPSED", status: "DONE", closedAt: cairo(2026, 8, 28, 12, 30), doneAppointmentId: v5.id });
    const work = await db.procedure.create({ data: { tenantId: a, patientId: p, treatmentId, doctorId, appointmentId: v5.id, performedAt: cairo(2026, 8, 28, 12), price: 2_500, status: "SIGNED", signedAt: cairo(2026, 8, 28, 13), signedById: doctorId } });
    await charge({ amount: 2_500, chargedAt: cairo(2026, 8, 28, 12), procedureId: work.id });
    const a6 = await recall(p, cairo(2026, 8, 15), { status: "DECLINED", declineReason: "price", closedAt: cairo(2026, 8, 16, 10), closedById: receptionId });
    await log(a6.id, "CALL", cairo(2026, 8, 16, 10), receptionId, "declined");
    await recall(p, cairo(2026, 8, 18), { kind: "UNBOOKED", status: "UNREACHABLE", closedAt: cairo(2026, 8, 30, 9) });
    // July: one due, booked in time.
    await recall(p, cairo(2026, 7, 10), { status: "BOOKED", bookedAt: cairo(2026, 7, 9), bookedAppointmentId: "visit-july" });
    // Waiting now (counted as it stands, whatever the period): planned work and a course's next session not booked, and a lapsed patient.
    const before = (await resultsRoute(request("/api/recalls/results", { cookie: ownerCookie })).then(json)).json.results;
    await recall(p, cairo(2026, 10, 20), { kind: "UNBOOKED", value: 4_500 });
    await recall(p, cairo(2026, 10, 22), { kind: "NEXT_SESSION", stage: 3, value: 1_800 });
    await recall(p, cairo(2026, 10, 1), { kind: "LAPSED" });
    // Another clinic's recall due the same month counts nowhere here.
    await db.recall.create({ data: { tenantId: b, patientId: await patient("Elsewhere", b), kind: "REVIEW", label: "Elsewhere", dueAt: cairo(2026, 8, 5), windowEndAt: cairo(2026, 8, 19), dedupeKey: "test:b" } });

    const results = (cookie = ownerCookie) => resultsRoute(request("/api/recalls/results?period=custom&from=2026-08-01&to=2026-08-31", { cookie })).then(json);
    const owner = await results();
    expect(owner.status).toBe(200);
    expect(owner.json.period).toMatchObject({ fromKey: "2026-08-01", toKey: "2026-08-31" });
    const r = owner.json.results;
    expect(r.due).toEqual({ count: 7, contacted: 3, booked: 4, bookedInTime: 3 });
    expect(r.previousDue).toEqual({ count: 1, contacted: 0, booked: 1, bookedInTime: 1 });
    expect(r.byKind).toEqual([
      { kind: "REVIEW", label: "Review", due: 3, contacted: 3, booked: 2 },
      { kind: "NEXT_SESSION", label: "Next session", due: 1, contacted: 0, booked: 1 },
      { kind: "UNBOOKED", label: expect.any(String), due: 1, contacted: 0, booked: 0 },
      { kind: "MISSED", label: expect.any(String), due: 1, contacted: 0, booked: 0 },
      { kind: "LAPSED", label: expect.any(String), due: 1, contacted: 0, booked: 1 },
    ]);
    expect(r.notBooked).toEqual({ planned: before.notBooked.planned + 1, sessions: before.notBooked.sessions + 1, value: before.notBooked.value + 6_300 });
    expect(r.lapsed).toEqual({ wonBack: 1, previousWonBack: 0, waiting: before.lapsed.waiting + 1 });
    // The visits that ended a recall in August: the session's charge and fee, the lapsed patient's procedure.
    expect(r.revenue).toEqual({ current: 1_800 + 300 + 2_500, previous: 0, visits: 2 });
    expect(r.ended).toEqual({ done: 2, declined: 1, unreachable: 1, endedAutomatically: 1, reasons: [{ key: "price", label: expect.any(String), count: 1 }] });
    expect(r.byPerson).toEqual([
      { id: receptionId, name: "Desk", calls: 2, messages: 0, booked: 1, declined: 1, unreachable: 0 },
      { id: null, name: "Automatically", calls: 0, messages: 1, booked: 0, declined: 0, unreachable: 1 },
    ]);

    // Reception reads the results without the money; the assistant too.
    const desk = await results(receptionCookie);
    expect(desk.status).toBe(200);
    expect(desk.json.results.revenue).toBeNull();
    expect(desk.json.results.due.count).toBe(7);
    expect((await results(assistantCookie)).json.results.revenue).toBeNull();
    expect((await resultsRoute(request("/api/recalls/results"))).status).toBe(401);
  });

  it("every recall ends: one left waiting long after its window, with nothing done on it, is ended as unreachable", async () => {
    const p = await patient("Forgotten Patient");
    const now = new Date();
    const old = { dueAt: new Date(now.getTime() - 100 * DAY), windowEndAt: new Date(now.getTime() - 70 * DAY) };
    const forgotten = await recall(p, old.dueAt, { windowEndAt: old.windowEndAt, createdAt: old.dueAt });
    await log(forgotten.id, "STATUS", old.dueAt, null, "OPEN");
    const calledLately = await recall(p, old.dueAt, { windowEndAt: old.windowEndAt, status: "CONTACTED", attempts: 1 });
    await log(calledLately.id, "CALL", new Date(now.getTime() - 10 * DAY), receptionId);
    const younger = await recall(p, new Date(now.getTime() - 50 * DAY), { windowEndAt: new Date(now.getTime() - 30 * DAY) });

    // The other tests' recalls are in this clinic too: count on this patient's.
    expect((await sweepRecalls(now, { tenantId: a })).ended).toBeGreaterThanOrEqual(1);
    const ended = await db.recall.findUniqueOrThrow({ where: { id: forgotten.id } });
    expect(ended).toMatchObject({ status: "UNREACHABLE", closedById: null });
    expect(ended.closedAt).toEqual(now);
    expect(ended.outcomeNote).toMatch(/^Not booked 60 days after its window ended, nothing done on it for 30: ended automatically\.$/);
    const last = await db.recallActivity.findFirstOrThrow({ where: { recallId: forgotten.id }, orderBy: { at: "desc" } });
    expect(last).toMatchObject({ kind: "STATUS", outcome: "UNREACHABLE", byId: null });
    expect((await db.recall.findUniqueOrThrow({ where: { id: calledLately.id } })).status).toBe("CONTACTED");
    expect((await db.recall.findUniqueOrThrow({ where: { id: younger.id } })).status).toBe("OPEN");
    // Once: the next pass changes nothing more on it.
    const logged = await db.recallActivity.count({ where: { recallId: forgotten.id } });
    await sweepRecalls(new Date(now.getTime() + 60_000), { tenantId: a });
    expect(await db.recallActivity.count({ where: { recallId: forgotten.id } })).toBe(logged);
  });
});

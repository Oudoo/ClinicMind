/**
 * Instalment plans (Phase 5) over the real route handlers and the test
 * database: a plan is a down payment and so many instalments every so many
 * months from a first day, in whole pounds with the odd pounds on the last;
 * its schedule never changes (the database refuses it) and it is never
 * deleted, only stopped with a reason. Payments recorded towards it (by the
 * patient or the head of their family) cover its instalments in order, the
 * plan completes when they are all covered and opens again when a payment is
 * voided; an accepted treatment plan is paid in instalments once at a time.
 * The overdue and due-this-week lists and the desk's figures; the reminder
 * before each instalment and the message the day after one is missed, once
 * each, never in the quiet hours, never to a patient who said no, the desk
 * told what became overdue; the desk's reminder now; RBAC and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { addMonthsToKey, coverInstalments, daysBetweenKeys, planPosition, scheduleOf, splitAmount } from "@/modules/finance/instalment-schedule";
import { createPlan, instalmentMessage, sendInstalmentReminders, settlePlan } from "@/modules/finance/instalments";
import { acceptQuote, createDraft, giveQuote } from "@/modules/quotes/service";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { GET as listRoute, POST as createRoute } from "@/app/api/instalments/route";
import { GET as getRoute } from "@/app/api/instalments/[id]/route";
import { POST as cancelRoute } from "@/app/api/instalments/[id]/cancel/route";
import { POST as remindRoute } from "@/app/api/instalments/[id]/remind/route";
import { POST as paymentRoute } from "@/app/api/payments/route";
import { POST as voidRoute } from "@/app/api/payments/[id]/void/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, openShifts, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const dayKey = (n: number, from = new Date()) => dateKeyInTz(addDays(from, n, TZ), TZ);
/** Today (or `n` days from it) at `hour` on the clinic clock. */
const at = (n: number, hour: number) => {
  const p = zonedParts(addDays(new Date(), n, TZ), TZ);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: Math.floor(hour), minute: Math.round((hour % 1) * 60) }, TZ);
};
const SIGNATURE = "M20,120 L60,90 L100,110 L140,70 L180,100 L220,60 L260,95 L300,80";

describe("instalment schedules (pure)", () => {
  it("splits into equal whole pounds, the odd pounds on the last", () => {
    expect(splitAmount(10_000, 3)).toEqual([3_333, 3_333, 3_334]);
    expect(splitAmount(60_000, 6)).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(splitAmount(5, 5)).toEqual([1, 1, 1, 1, 1]);
  });

  it("counts months on the same day, or the month's last day, from the first instalment each time", () => {
    expect(addMonthsToKey("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonthsToKey("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonthsToKey("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonthsToKey("2026-03-31", -1)).toBe("2026-02-28");
    expect(daysBetweenKeys("2026-10-29", "2026-11-01")).toBe(3);
    expect(daysBetweenKeys("2026-11-01", "2026-10-29")).toBe(-3);
    const schedule = scheduleOf({ total: 75_001, downPayment: 15_000, count: 6, everyMonths: 1, firstDue: "2026-11-30", startKey: "2026-10-29" });
    expect(schedule.map((s) => [s.number, s.dueKey, s.amount])).toEqual([
      [0, "2026-10-29", 15_000],
      [1, "2026-11-30", 10_000],
      [2, "2026-12-30", 10_000],
      [3, "2027-01-30", 10_000],
      [4, "2027-02-28", 10_000],
      [5, "2027-03-30", 10_000],
      [6, "2027-04-30", 10_001],
    ]);
    expect(scheduleOf({ total: 9_000, downPayment: 0, count: 3, everyMonths: 3, firstDue: "2026-12-01", startKey: "2026-11-01" }).map((s) => s.dueKey)).toEqual(["2026-12-01", "2027-03-01", "2027-06-01"]);
  });

  it("covers the instalments in order with what was paid: paid, overdue, due soon, upcoming", () => {
    const schedule = scheduleOf({ total: 25_000, downPayment: 5_000, count: 2, everyMonths: 1, firstDue: "2026-11-30", startKey: "2026-10-29" });
    const on = (paid: number, today: string) => coverInstalments(schedule, paid, today, 3).map((i) => [i.number, i.covered, i.owed, i.state, i.daysLate]);
    expect(on(12_000, "2026-11-01")).toEqual([
      [0, 5_000, 0, "PAID", 0],
      [1, 7_000, 3_000, "UPCOMING", 0],
      [2, 0, 10_000, "UPCOMING", 0],
    ]);
    expect(on(12_000, "2026-11-27")[1]).toEqual([1, 7_000, 3_000, "DUE", 0]);
    expect(on(12_000, "2026-12-04")[1]).toEqual([1, 7_000, 3_000, "OVERDUE", 4]);
    const position = planPosition(25_000, coverInstalments(schedule, 12_000, "2027-01-02", 3));
    expect(position).toMatchObject({ paid: 12_000, left: 13_000, overdue: 13_000, daysLate: 33, paidInstalments: 0 });
    expect(position.next).toMatchObject({ number: 1, owed: 3_000 });
    expect(planPosition(25_000, coverInstalments(schedule, 30_000, "2027-01-02", 3))).toMatchObject({ paid: 25_000, left: 0, overdue: 0, next: null, paidInstalments: 2 });
  });

  it("writes the reminders in the patient's language: before the day, and once it has passed", () => {
    const base = { patientName: "Salma Adel", clinicName: "Aura", clinicPhone: "+20225551234", title: "Hair transplant", number: 2, count: 6, amount: 10_000, dueAt: new Date("2026-11-30T10:00:00Z"), timezone: TZ };
    expect(instalmentMessage({ ...base, kind: "due", language: "en" })).toBe("Hi Salma, a reminder from Aura: instalment 2 of 6 for your Hair transplant, 10,000 EGP, is due on Monday 30 November. Thank you.");
    expect(instalmentMessage({ ...base, kind: "overdue", language: "en" })).toBe(
      "Hi Salma, instalment 2 of 6 for your Hair transplant, 10,000 EGP, was due on Monday 30 November and is still open. You can pay at the clinic, or call us on +20225551234 if you need another arrangement.",
    );
    expect(instalmentMessage({ ...base, kind: "due", language: "ar" })).toBe("مرحبًا Salma، تذكير من Aura: القسط 2 من 6 لـ«Hair transplant» بقيمة 10,000 جنيه مستحق يوم الاثنين 30 نوفمبر. شكرًا لك.");
    expect(instalmentMessage({ ...base, kind: "overdue", language: "en", number: 0, clinicPhone: null })).toBe(
      "Hi Salma, the down payment for your Hair transplant, 10,000 EGP, was due on Monday 30 November and is still open. You can pay at the clinic, or call us if you need another arrangement.",
    );
  });
});

describe.skipIf(!dbTestsEnabled)("instalment plan routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let ownerId: string;
  let receptionId: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let nurseCookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let doctorId: string;
  let priceItem: string;
  let patientB: string;
  let n = 0;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const make = (body: Record<string, unknown>, cookie = receptionCookie) => createRoute(request("/api/instalments", { method: "POST", cookie, body })).then(json);
  const read = (id: string, cookie = receptionCookie) => getRoute(request(`/api/instalments/${id}`, { cookie }), params(id)).then(json);
  const list = (query: string, cookie = receptionCookie) => listRoute(request(`/api/instalments?${query}`, { cookie })).then(json);
  const cancel = (id: string, body: unknown, cookie = receptionCookie) => cancelRoute(request(`/api/instalments/${id}/cancel`, { method: "POST", cookie, body }), params(id)).then(json);
  const remind = (id: string, cookie = receptionCookie) => remindRoute(request(`/api/instalments/${id}/remind`, { method: "POST", cookie }), params(id)).then(json);
  const pay = (body: Record<string, unknown>, cookie = receptionCookie) => paymentRoute(request("/api/payments", { method: "POST", cookie, body: { kind: "PAYMENT", method: "CASH", ...body } })).then(json);
  const voidPayment = (id: string, reason: string) => voidRoute(request(`/api/payments/${id}/void`, { method: "POST", cookie: ownerCookie, body: { reason } }), params(id)).then(json);
  const patient = async (name: string, extra: Record<string, unknown> = {}, tenantId = a) =>
    (await db.patient.create({ data: { tenantId, fullName: name, phone: `+2010077${String(++n).padStart(5, "0")}`, language: "en", ...extra } })).id;
  const terms = (patientId: string, extra: Record<string, unknown> = {}) => ({ patientId, title: "Hair transplant", total: 9_000, downPayment: 3_000, count: 3, firstDue: dayKey(10), ...extra });

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `inst-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `inst-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerId = owner.id;
    receptionId = reception.id;
    doctorId = doctor.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await openShifts(a, [owner.id, reception.id, nurse.id]);
    await ensureDefaultTreatments(a);
    const treatment = await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "hair-transplant" } });
    priceItem = (
      await db.priceItem.create({
        data: { tenantId: a, code: "FUE-P", name: "FUE hair transplant", category: "hair", unit: "PACKAGE", treatmentId: treatment.id, prices: { create: { tenantId: a, amount: 60_000, effectiveFrom: new Date(Date.now() - 400 * DAY) } } },
      })
    ).id;
    patientB = await patient("Patient Of B", {}, b);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("making a plan", () => {
    it("schedules the down payment today and the instalments every month from the first day, the odd pounds on the last; on the timeline and in the audit", async () => {
      const p = await patient("Salma Adel");
      const made = await make(terms(p, { total: 75_001, downPayment: 15_000, count: 6, firstDue: dayKey(30) }));
      expect(made.res.status, JSON.stringify(made.json)).toBe(201);
      const plan = made.json.plan;
      expect(plan).toMatchObject({ status: "ACTIVE", total: 75_001, downPayment: 15_000, count: 6, everyMonths: 1, reminderDays: 3, quote: null, patient: { id: p, reminderConsent: true } });
      expect(plan.instalments.map((i: { number: number; dueKey: string; amount: number; state: string }) => [i.number, i.dueKey, i.amount, i.state])).toEqual([
        [0, dayKey(0), 15_000, "DUE"],
        ...[0, 1, 2, 3, 4, 5].map((k) => [k + 1, addMonthsToKey(dayKey(30), k), k === 5 ? 10_001 : 10_000, "UPCOMING"]),
      ]);
      expect(plan.position).toMatchObject({ paid: 0, left: 75_001, overdue: 0, next: { number: 0, owed: 15_000 } });
      expect(await db.timelineEvent.count({ where: { tenantId: a, patientId: p, kind: "PAYMENT", refId: plan.id } })).toBe(1);
      expect(await db.auditLog.findFirst({ where: { tenantId: a, action: "instalments.create", entityId: plan.id }, select: { patientId: true, actorId: true } })).toEqual({ patientId: p, actorId: receptionId });
      expect((await read(plan.id, ownerCookie)).json.plan.id).toBe(plan.id);
    });

    it("refuses terms that cannot be: a down payment of the whole, more instalments than pounds, a day gone or more than a year off, every five months", async () => {
      const p = await patient("Omar Fathy");
      for (const bad of [
        { downPayment: 9_000 },
        { total: 5, downPayment: 0, count: 6 },
        { firstDue: dayKey(-1) },
        { firstDue: dayKey(400) },
        { everyMonths: 5 },
        { count: 61 },
        { title: "" },
      ]) {
        const res = await make(terms(p, bad));
        expect(res.res.status, JSON.stringify(bad)).toBe(422);
      }
      expect((await make(terms("no-such-patient"))).res.status).toBe(404);
      expect((await make(terms(patientB))).res.status).toBe(404);
    });

    it("is for the front desk and the owner: a nurse at the desk makes one, a doctor or an assistant does not see them; another clinic never does", async () => {
      const p = await patient("Hoda Samir");
      expect((await make(terms(p), nurseCookie)).res.status).toBe(201);
      expect((await make(terms(p), doctorCookie)).res.status).toBe(403);
      expect((await list(`patientId=${p}`, doctorCookie)).res.status).toBe(403);
      expect((await list(`patientId=${p}`, assistantCookie)).res.status).toBe(403);
      const mine = await list(`patientId=${p}`, ownerCookie);
      expect(mine.json.total).toBe(1);
      expect((await read(mine.json.plans[0].id, ownerBCookie)).res.status).toBe(404);
      expect((await list("view=active", ownerBCookie)).json.total).toBe(0);
      expect((await cancel(mine.json.plans[0].id, { reason: "Not theirs to stop" }, ownerBCookie)).res.status).toBe(404);
    });

    it("pays for an accepted treatment plan, once at a time: not one only given, not twice, again once the first is stopped", async () => {
      const p = await patient("Karim Adel");
      const actor = { id: receptionId, email: "desk@a.test", role: "RECEPTIONIST" as const };
      const quote = await createDraft(a, { patientId: p, doctorId, title: "Hair restoration", phases: [{ title: "The transplant", items: [{ priceItemId: priceItem }] }] }, actor);
      await giveQuote(a, quote.id, actor);
      const given = await make(terms(p, { quoteId: quote.id, total: 60_000, downPayment: 10_000, count: 5 }));
      expect(given.res.status).toBe(409);
      expect(given.json.message).toContain("Only an accepted treatment plan");
      const accepted = await acceptQuote(a, quote.id, { itemIds: quote.items.map((i) => i.id), name: "Karim Adel", signature: SIGNATURE, agree: true }, "clinic", actor);
      const first = await make(terms(p, { quoteId: quote.id, title: accepted.title, total: accepted.acceptedTotal, downPayment: 10_000, count: 5 }));
      expect(first.res.status, JSON.stringify(first.json)).toBe(201);
      expect(first.json.plan.quote).toEqual({ id: quote.id, number: accepted.number });
      const twice = await make(terms(p, { quoteId: quote.id, total: 60_000, downPayment: 10_000, count: 5 }));
      expect(twice.res.status).toBe(409);
      expect(twice.json.message).toContain("being paid in instalments already");
      expect((await cancel(first.json.plan.id, { reason: "Terms changed: a larger down payment" })).res.status).toBe(200);
      expect((await make(terms(p, { quoteId: quote.id, total: 60_000, downPayment: 30_000, count: 3 }))).res.status).toBe(201);
      // Someone else's treatment plan is not this patient's to pay.
      expect((await make(terms(await patient("Not Karim"), { quoteId: quote.id, total: 60_000 }))).res.status).toBe(404);
    });
  });

  describe("payments towards a plan", () => {
    let p: string;
    let planId: string;
    let second: string;

    beforeAll(async () => {
      p = await patient("Mona Fawzy");
      planId = (await make(terms(p))).json.plan.id;
    });

    it("covers the down payment first, then the instalments in order; the payment says which plan on the timeline", async () => {
      const down = await pay({ patientId: p, amount: 3_000, instalmentPlanId: planId });
      expect(down.res.status, JSON.stringify(down.json)).toBe(201);
      expect(down.json.payment.instalmentPlanId).toBe(planId);
      let plan = (await read(planId)).json.plan;
      expect(plan.instalments.map((i: { number: number; owed: number; paidAt: string | null }) => [i.number, i.owed, Boolean(i.paidAt)])).toEqual([
        [0, 0, true],
        [1, 2_000, false],
        [2, 2_000, false],
        [3, 2_000, false],
      ]);
      const more = await pay({ patientId: p, amount: 2_500, instalmentPlanId: planId, method: "CARD" });
      second = more.json.payment.id;
      plan = (await read(planId)).json.plan;
      expect(plan.instalments.map((i: { owed: number }) => i.owed)).toEqual([0, 0, 1_500, 2_000]);
      expect(plan.position).toMatchObject({ paid: 5_500, left: 3_500, next: { number: 2, owed: 1_500 } });
      const event = await db.timelineEvent.findFirstOrThrow({ where: { tenantId: a, refId: second } });
      expect(event.body).toContain("Instalment plan: Hair transplant");
      // A consultation fee goes towards no plan.
      expect((await pay({ patientId: p, kind: "CONSULTATION_FEE", amount: 500, instalmentPlanId: planId })).res.status).toBe(422);
    });

    it("completes when every instalment is covered, takes nothing more, and opens again when a payment is voided", async () => {
      const last = await pay({ patientId: p, amount: 3_500, instalmentPlanId: planId });
      expect(last.res.status).toBe(201);
      let plan = (await read(planId)).json.plan;
      expect(plan).toMatchObject({ status: "COMPLETED", position: { left: 0, next: null } });
      expect(plan.completedAt).not.toBeNull();
      const extra = await pay({ patientId: p, amount: 100, instalmentPlanId: planId });
      expect(extra.res.status).toBe(409);
      expect(extra.json.message).toContain("paid in full");
      expect((await voidPayment(second, "Card payment reversed by the bank")).res.status).toBe(200);
      plan = (await read(planId)).json.plan;
      expect(plan).toMatchObject({ status: "ACTIVE", completedAt: null, position: { paid: 6_500, left: 2_500 } });
      expect(plan.instalments.map((i: { owed: number; paidAt: string | null }) => [i.owed, Boolean(i.paidAt)])).toEqual([
        [0, true],
        [0, true],
        [500, false],
        [2_000, false],
      ]);
    });

    it("the head of a family pays towards a member's plan; nobody pays towards a stranger's", async () => {
      const head = await patient("Hany Fawzy");
      await db.patient.update({ where: { id: p }, data: { householdHeadId: head, householdRelation: "CHILD" } });
      const choices = await list(`patientId=${head}&payable=1&view=active`);
      expect(choices.json.plans.map((x: { id: string }) => x.id)).toContain(planId);
      expect(choices.json.plans[0]).toMatchObject({ patient: { id: p }, position: { next: { number: 2, owed: 500 } } });
      expect((await pay({ patientId: head, amount: 500, instalmentPlanId: planId })).res.status).toBe(201);
      expect((await read(planId)).json.plan.position.next).toMatchObject({ number: 3, owed: 2_000 });
      const stranger = await patient("Nader Kamel");
      expect((await pay({ patientId: stranger, amount: 500, instalmentPlanId: planId })).res.status).toBe(404);
    });
  });

  describe("stopping a plan", () => {
    it("stops with a reason: no more payments towards it, what was paid stays; once only", async () => {
      const p = await patient("Rana Ali");
      const planId = (await make(terms(p))).json.plan.id;
      expect((await pay({ patientId: p, amount: 3_000, instalmentPlanId: planId })).res.status).toBe(201);
      expect((await cancel(planId, { reason: "x" })).res.status).toBe(422);
      expect((await cancel(planId, { reason: "Paused" }, doctorCookie)).res.status).toBe(403);
      const stopped = await cancel(planId, { reason: "Moved abroad; will pay the rest on return" });
      expect(stopped.res.status).toBe(200);
      expect(stopped.json.plan).toMatchObject({ status: "CANCELLED", cancelReason: "Moved abroad; will pay the rest on return", position: { paid: 3_000 } });
      expect((await cancel(planId, { reason: "Again" })).res.status).toBe(409);
      const after = await pay({ patientId: p, amount: 2_000, instalmentPlanId: planId });
      expect(after.res.status).toBe(409);
      expect(after.json.message).toContain("stopped");
      expect((await list(`patientId=${p}&view=cancelled`)).json.total).toBe(1);
      expect(await db.auditLog.count({ where: { tenantId: a, action: "instalments.cancel", entityId: planId, patientId: p } })).toBe(1);
    });

    it("the database keeps every plan and its schedule as made", async () => {
      const p = await patient("Laila Nour");
      const plan = (await make(terms(p))).json.plan;
      await expect(db.instalmentPlan.delete({ where: { id: plan.id } })).rejects.toThrow(/never deleted/);
      const first = plan.instalments[1];
      await expect(db.instalment.update({ where: { id: first.id }, data: { amount: 1 } })).rejects.toThrow(/never changes/);
      await expect(db.instalment.update({ where: { id: first.id }, data: { dueAt: new Date() } })).rejects.toThrow(/never changes/);
      await expect(db.instalment.delete({ where: { id: first.id } })).rejects.toThrow(/never deleted/);
      await db.instalment.update({ where: { id: first.id }, data: { remindedAt: new Date() } });
    });
  });

  describe("the desk's lists and reminders", () => {
    let late: string;
    let later: string;
    let soon: string;
    let lateName: string;

    beforeAll(async () => {
      // Made weeks ago (as on the day), their first instalments missed.
      const desk = { id: receptionId };
      lateName = "Yara Lotfy";
      late = (await createPlan(a, terms(await patient(lateName), { firstDue: dayKey(-40), downPayment: 0 }), desk, { now: new Date(Date.now() - 45 * DAY) })).id;
      later = (await createPlan(a, terms(await patient("Sara Lotfy"), { firstDue: dayKey(-6), downPayment: 0 }), desk, { now: new Date(Date.now() - 20 * DAY) })).id;
      soon = (await make(terms(await patient("Dina Lotfy"), { firstDue: dayKey(2), downPayment: 0 }))).json.plan.id;
    });

    it("lists what is overdue (the latest first) and what falls due this week, with the desk's figures", async () => {
      const overdue = await list("view=overdue&kpis=1&q=Lotfy");
      expect(overdue.res.status).toBe(200);
      expect(overdue.json.plans.map((x: { id: string }) => x.id)).toEqual([late, later]);
      expect(overdue.json.plans[0].position).toMatchObject({ overdue: 6_000, next: { number: 1, state: "OVERDUE" } });
      expect(overdue.json.plans[0].position.daysLate).toBe(40);
      const due = await list("view=due&q=Lotfy");
      expect(due.json.plans.map((x: { id: string }) => x.id)).toEqual([soon]);
      expect(due.json.plans[0].dueThisWeek).toMatchObject({ number: 1, dueKey: dayKey(2), state: "DUE" });
      expect(overdue.json.kpis.overdue.plans).toBeGreaterThanOrEqual(2);
      expect(overdue.json.kpis.overdue.amount).toBeGreaterThanOrEqual(6_000 + 3_000);
      expect(overdue.json.kpis.dueThisWeek.amount).toBeGreaterThanOrEqual(3_000);
      expect(overdue.json.kpis.collectedThisMonth).toBeGreaterThan(0);
    });

    it("the desk reminds now, in the patient's language; not one who said no, nor without a number, nor a plan paid in full", async () => {
      const sent = await remind(late);
      expect(sent.res.status, JSON.stringify(sent.json)).toBe(200);
      const message = await db.message.findFirstOrThrow({ where: { tenantId: a, conversationId: sent.json.conversationId }, orderBy: { createdAt: "desc" } });
      expect(message).toMatchObject({ templateKey: "instalment:overdue", author: "HUMAN", direction: "OUTBOUND" });
      expect(message.body).toMatch(/^Hi Yara, instalment 1 of 3 for your Hair transplant, 3,000 EGP, was due on /);
      const first = await db.instalment.findFirstOrThrow({ where: { planId: late, number: 1 } });
      expect(first.overdueRemindedAt).not.toBeNull();
      expect(await db.auditLog.count({ where: { tenantId: a, action: "instalments.remind", entityId: late } })).toBe(1);

      const noConsent = (await make(terms(await patient("Fady Nour", { reminderConsent: false })))).json.plan.id;
      const said = await remind(noConsent);
      expect(said.res.status).toBe(409);
      expect(said.json.error).toBe("no_consent");
      const noPhone = (await make(terms(await patient("Mai Nour", { phone: null })))).json.plan.id;
      expect((await remind(noPhone)).json.error).toBe("no_phone");
      const p = await patient("Adel Nour");
      const paid = (await make(terms(p, { total: 3_000, downPayment: 0, count: 1, firstDue: dayKey(0) }))).json.plan.id;
      await pay({ patientId: p, amount: 3_000, instalmentPlanId: paid });
      expect((await remind(paid)).res.status).toBe(409);
      expect((await remind(soon, doctorCookie)).res.status).toBe(403);
    });
  });

  describe("the reminder job", () => {
    let c: string;
    let deskC: string;
    let ownerC: string;
    let soon: string;
    let quiet: string;
    let missed: string;
    let paid: string;
    let stopped: string;
    let refused: string;
    const patientC = async (name: string, extra: Record<string, unknown> = {}) => patient(name, { language: "ar", ...extra }, c);
    const messagesOf = (planId: string) => db.message.findMany({ where: { tenantId: c, meta: { path: ["instalmentPlanId"], equals: planId } }, orderBy: { createdAt: "asc" } });

    beforeAll(async () => {
      const tenantC = await createTenant({ slug: `inst-c-${Date.now().toString(36)}` });
      c = tenantC.id;
      created.push(c);
      deskC = (await createUser({ tenantId: c, role: "RECEPTIONIST", fullName: "Desk C" })).id;
      ownerC = (await createUser({ tenantId: c, role: "CLINIC_OWNER", fullName: "Owner C" })).id;
      await createUser({ tenantId: c, role: "DOCTOR", fullName: "Dr. C" });
      const desk = { id: deskC };
      const now = at(0, 9);
      const weeksAgo = new Date(now.getTime() - 20 * DAY);
      soon = (await createPlan(c, terms(await patientC("Salma Fathy"), { firstDue: dayKey(2) }), desk, { now })).id;
      quiet = (await createPlan(c, terms(await patientC("Nada Fathy"), { firstDue: dayKey(3), downPayment: 0, reminderDays: 1 }), desk, { now })).id;
      missed = (await createPlan(c, terms(await patientC("Mostafa Fathy"), { firstDue: dayKey(-2), downPayment: 0 }), desk, { now: weeksAgo })).id;
      paid = (await createPlan(c, terms(await patientC("Hana Fathy"), { firstDue: dayKey(1), downPayment: 0 }), desk, { now })).id;
      stopped = (await createPlan(c, terms(await patientC("Ali Fathy"), { firstDue: dayKey(1), downPayment: 0 }), desk, { now })).id;
      refused = (await createPlan(c, terms(await patientC("Reem Fathy", { reminderConsent: false }), { firstDue: dayKey(1), downPayment: 0 }), desk, { now })).id;
      // Paid in full towards one; another stopped.
      const hana = (await db.instalmentPlan.findUniqueOrThrow({ where: { id: paid } })).patientId;
      await db.payment.create({ data: { tenantId: c, patientId: hana, kind: "PAYMENT", method: "CASH", amount: 9_000, paidAt: now, instalmentPlanId: paid } });
      await db.$transaction((tx) => settlePlan(tx, c, paid, now));
      await db.instalmentPlan.update({ where: { id: stopped }, data: { status: "CANCELLED", cancelledAt: now, cancelReason: "Stopped" } });
    });

    it("says nothing in the quiet hours", async () => {
      const summary = await sendInstalmentReminders(at(0, 23), { tenantId: c });
      expect(summary).toMatchObject({ tenants: 1, reminded: 0, overdue: 0 });
      expect(await db.message.count({ where: { tenantId: c } })).toBe(0);
    });

    it("reminds before each instalment within the plan's days, writes the day after one is missed, tells the desk; once each", async () => {
      const noon = at(0, 12);
      const summary = await sendInstalmentReminders(noon, { tenantId: c });
      expect(summary).toMatchObject({ tenants: 1, reminded: 1, overdue: 1, failed: 0 });
      // In two days, within its three: the reminder, in Arabic (the down payment due today has none).
      const due = await messagesOf(soon);
      expect(due.map((m) => m.templateKey)).toEqual(["instalment:due"]);
      expect(due[0]!.body).toMatch(/^مرحبًا Salma، تذكير من .+: القسط 1 من 3 لـ«Hair transplant» بقيمة 2,000 جنيه مستحق يوم /);
      expect((await db.instalment.findFirstOrThrow({ where: { planId: soon, number: 1 } })).remindedAt?.getTime()).toBe(noon.getTime());
      expect((await db.instalment.findFirstOrThrow({ where: { planId: soon, number: 0 } })).remindedAt).toBeNull();
      // Its day two days ago: the overdue message, and the desk and the owner told.
      expect((await messagesOf(missed)).map((m) => m.templateKey)).toEqual(["instalment:overdue"]);
      const told = await db.notification.findMany({ where: { tenantId: c, kind: "INSTALMENT_OVERDUE" }, select: { userId: true, href: true, title: true } });
      expect(told.map((x) => x.userId).sort()).toEqual([deskC, ownerC].sort());
      expect(told[0]).toMatchObject({ href: "/dashboard/finance/instalments?view=overdue", title: "An instalment is overdue: Mostafa Fathy" });
      // Not yet within its one day; paid; stopped: nothing.
      expect(await messagesOf(quiet)).toEqual([]);
      expect(await messagesOf(paid)).toEqual([]);
      expect(await messagesOf(stopped)).toEqual([]);
      // Said no: claimed, but no message.
      expect(await messagesOf(refused)).toEqual([]);
      expect((await db.instalment.findFirstOrThrow({ where: { planId: refused, number: 1 } })).remindedAt).not.toBeNull();

      const again = await sendInstalmentReminders(new Date(noon.getTime() + 30 * 60_000), { tenantId: c });
      expect(again).toMatchObject({ reminded: 0, overdue: 0 });
      expect(await db.notification.count({ where: { tenantId: c, kind: "INSTALMENT_OVERDUE" } })).toBe(2);
    });
  });
});

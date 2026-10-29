/**
 * Doctor pay (Phase 5) over the real route handlers and the test database:
 * per doctor and category, a share of what is billed or collected (the lab
 * and material costs off first, when the rule says so) or a fixed fee a
 * session; never below zero; a month's statement pays what each piece of
 * work had earned by the month's end less what earlier statements paid, so
 * late money, later costs and cancellations count in their own month (owed
 * back is carried to the next); months close in order once over, never
 * change after (the database refuses it) but to be marked paid; procedure
 * costs added by the desk and voided by the owner; RBAC and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { dateKeyInTz, fromDateKey, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { describeTerms, earnedBy, isMonthKey, monthLabel, monthOfKey, ruleFor, settle, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { GET as rulesGet, POST as rulesPost } from "@/app/api/doctor-pay/rules/route";
import { DELETE as ruleDelete } from "@/app/api/doctor-pay/rules/[id]/route";
import { GET as overviewGet } from "@/app/api/doctor-pay/statements/route";
import { GET as statementGet } from "@/app/api/doctor-pay/statements/[doctorId]/route";
import { POST as closePost } from "@/app/api/doctor-pay/statements/[doctorId]/close/route";
import { POST as paidPost } from "@/app/api/doctor-pay/statements/[doctorId]/paid/route";
import { POST as costPost } from "@/app/api/procedures/[id]/costs/route";
import { POST as costVoid } from "@/app/api/procedure-costs/[id]/void/route";
import { PATCH as pricePatch } from "@/app/api/prices/[id]/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const thisMonth = monthOfKey(dateKeyInTz(new Date(), TZ));
const M3 = shiftMonth(thisMonth, -3);
const M2 = shiftMonth(thisMonth, -2);
const M1 = shiftMonth(thisMonth, -1);
/** The `day`th of a month at `hour`, clinic clock. */
const on = (month: string, day: number, hour = 12) => {
  const p = zonedParts(fromDateKey(`${month}-01`, TZ)!, TZ);
  return zonedTimeToUtc({ year: p.year, month: p.month, day, hour }, TZ);
};

describe("doctor pay (pure)", () => {
  const work = { billed: 10_000, collected: 4_000, costs: 1_000, sessions: 2 };
  it("earns a share of what is billed or collected, the costs off first when the rule says so, or a fee a session; never below zero", () => {
    expect(earnedBy({ basis: "BILLED", rate: 3_000, amount: null, deductCosts: true }, work)).toBe(2_700);
    expect(earnedBy({ basis: "BILLED", rate: 3_000, amount: null, deductCosts: false }, work)).toBe(3_000);
    expect(earnedBy({ basis: "COLLECTED", rate: 4_000, amount: null, deductCosts: true }, work)).toBe(1_200);
    expect(earnedBy({ basis: "COLLECTED", rate: 3_750, amount: null, deductCosts: false }, { ...work, collected: 1_001 })).toBe(375);
    expect(earnedBy({ basis: "FIXED", rate: null, amount: 250, deductCosts: false }, work)).toBe(500);
    expect(earnedBy({ basis: "COLLECTED", rate: 4_000, amount: null, deductCosts: true }, { ...work, collected: 500 })).toBe(0);
    expect(earnedBy(null, work)).toBe(0);
  });

  it("takes the category's own rule, else the rule for everything else", () => {
    const rules = [{ category: "laser" }, { category: "*" }];
    expect(ruleFor(rules, "laser")).toBe(rules[0]);
    expect(ruleFor(rules, "hair")).toBe(rules[1]);
    expect(ruleFor(rules, null)).toBe(rules[1]);
    expect(ruleFor([{ category: "laser" }], "hair")).toBeNull();
  });

  it("settles a month with what was owed back: pays what is above zero, carries what is below", () => {
    expect(settle(1_500, 0)).toEqual({ payable: 1_500, carriedForward: 0 });
    expect(settle(1_500, -1_000)).toEqual({ payable: 500, carriedForward: 0 });
    expect(settle(-1_000, 0)).toEqual({ payable: 0, carriedForward: -1_000 });
    expect(settle(300, -1_000)).toEqual({ payable: 0, carriedForward: -700 });
  });

  it("words the rules and the months", () => {
    expect(describeTerms({ basis: "BILLED", rate: 3_750, amount: null, deductCosts: true })).toBe("37.5% of what is billed, after costs");
    expect(describeTerms({ basis: "COLLECTED", rate: 4_000, amount: null, deductCosts: false })).toBe("40% of what is collected");
    expect(describeTerms({ basis: "FIXED", rate: null, amount: 1_250, deductCosts: false })).toBe("1,250 EGP a session");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(monthLabel("2026-10")).toBe("October 2026");
    expect(isMonthKey("2026-13")).toBe(false);
  });
});

describe.skipIf(!dbTestsEnabled)("doctor pay routes", () => {
  const created: string[] = [];
  let a: string;
  let branch: string;
  let ownerId: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let ownerBCookie: string;
  let receptionId: string;
  const doctors: Record<string, { id: string; cookie: string }> = {};
  const treatment: Record<string, string> = {};
  let injectable: string;
  let n = 0;
  let seq = 0;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });
  const setRule = (body: Record<string, unknown>, cookie = ownerCookie) => rulesPost(request("/api/doctor-pay/rules", { method: "POST", cookie, body })).then(json);
  const statement = (doctorId: string, month: string, cookie = ownerCookie) => statementGet(request(`/api/doctor-pay/statements/${doctorId}?month=${month}`, { cookie }), params("doctorId", doctorId)).then(json);
  const close = (doctorId: string, month: string, cookie = ownerCookie) => closePost(request(`/api/doctor-pay/statements/${doctorId}/close`, { method: "POST", cookie, body: { month } }), params("doctorId", doctorId)).then(json);
  const markPaid = (doctorId: string, body: Record<string, unknown>, cookie = ownerCookie) => paidPost(request(`/api/doctor-pay/statements/${doctorId}/paid`, { method: "POST", cookie, body }), params("doctorId", doctorId)).then(json);
  const patient = async (name: string) => (await db.patient.create({ data: { tenantId: a, fullName: name, phone: `+2010066${String(++n).padStart(5, "0")}` } })).id;
  /** Pay counted from the first month of the tests: the doctor's rules set then. */
  const backdateRules = (doctorId: string) => db.doctorPayRule.updateMany({ where: { tenantId: a, doctorId }, data: { createdAt: on(M3, 1, 9) } });

  /** A procedure done on a day (signed: one charge), or a course with sessions charged on days. */
  async function done(o: { patientId: string; doctorId: string; treatment: string; price: number; at: Date; priceItemId?: string; quantity?: number; sessions?: Date[]; stages?: number }) {
    const p = await db.procedure.create({
      data: {
        tenantId: a,
        patientId: o.patientId,
        treatmentId: treatment[o.treatment]!,
        priceItemId: o.priceItemId ?? null,
        quantity: o.quantity ?? 1,
        doctorId: o.doctorId,
        performedAt: o.at,
        price: o.price,
        stages: o.stages ?? 1,
        status: o.sessions ? "STARTED" : "SIGNED",
        signedAt: o.sessions ? null : o.at,
        startedAt: o.sessions ? o.at : null,
      },
    });
    const charges = o.sessions
      ? await Promise.all(
          o.sessions.map((day, i) =>
            db.charge.create({ data: { tenantId: a, patientId: o.patientId, procedureId: p.id, stage: i + 1, amount: Math.floor(o.price / (o.stages ?? 1)), description: `Session ${i + 1}`, chargedAt: day, doctorId: o.doctorId, clinicId: branch } }),
          ),
        )
      : [await db.charge.create({ data: { tenantId: a, patientId: o.patientId, procedureId: p.id, amount: o.price, description: "Work", chargedAt: o.at, doctorId: o.doctorId, clinicId: branch } })];
    return { id: p.id, charges };
  }
  /** Invoiced on a day, then paid in parts on their days. */
  async function billAndPay(patientId: string, charges: { id: string; amount: number; chargedAt: Date }[], issuedAt: Date, payments: [number, Date][]) {
    const total = charges.reduce((s, c) => s + c.amount, 0);
    const invoice = await db.invoice.create({
      data: { tenantId: a, clinicId: branch, patientId, status: "DRAFT", total, createdAt: issuedAt, lines: { create: charges.map((c, i) => ({ tenantId: a, chargeId: c.id, description: "Work", amount: c.amount, chargedAt: c.chargedAt, position: i + 1 })) } },
    });
    seq += 1;
    await db.invoice.update({ where: { id: invoice.id }, data: { status: "ISSUED", sequence: seq, number: `PAY-INV-${seq}`, issuedAt, issuedById: ownerId } });
    for (const [amount, paidAt] of payments) {
      const payment = await db.payment.create({ data: { tenantId: a, patientId, kind: "PAYMENT", method: "CASH", amount, paidAt, clinicId: branch } });
      await db.paymentAllocation.create({ data: { tenantId: a, paymentId: payment.id, invoiceId: invoice.id, amount } });
    }
    return invoice.id;
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `pay-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `pay-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    created.push(a, tenantB.id);
    branch = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    ownerId = owner.id;
    receptionId = reception.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    ownerBCookie = await sessionCookieFor((await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" })).id);
    for (const key of ["collected", "billed", "back", "order"]) {
      const user = await createUser({ tenantId: a, role: "DOCTOR", fullName: `Dr. ${key}` });
      doctors[key] = { id: user.id, cookie: await sessionCookieFor(user.id) };
    }
    await ensureDefaultTreatments(a);
    for (const t of await db.treatment.findMany({ where: { tenantId: a } })) treatment[t.key] = t.id;
    injectable = (
      await db.priceItem.create({
        data: { tenantId: a, code: "FIL", name: "Filler", category: "injectables", unit: "UNIT", unitLabel: "syringe", treatmentId: treatment["botox-fillers"]!, materialCost: 500, prices: { create: { tenantId: a, amount: 2_000, effectiveFrom: on(M3, 1, 0) } } },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("rules", () => {
    it("are the owner's to set: a share with two decimals or a fee a session, for the owner, doctors and nurses only", async () => {
      const d = doctors.collected!.id;
      const made = await setRule({ doctorId: d, category: "*", basis: "COLLECTED", percent: 40 });
      expect(made.res.status, JSON.stringify(made.json)).toBe(200);
      expect(made.json.rule).toMatchObject({ category: "*", basis: "COLLECTED", rate: 4_000, amount: null, deductCosts: true, terms: "40% of what is collected, after costs" });
      expect((await setRule({ doctorId: d, category: "laser", basis: "FIXED", amount: 250, deductCosts: true })).json.rule).toMatchObject({ amount: 250, rate: null, deductCosts: false });
      expect((await setRule({ doctorId: d, category: "laser", basis: "BILLED", percent: 12.345 })).res.status).toBe(422);
      expect((await setRule({ doctorId: d, category: "laser", basis: "BILLED", percent: 150 })).res.status).toBe(422);
      expect((await setRule({ doctorId: d, category: "laser", basis: "FIXED" })).res.status).toBe(422);
      expect((await setRule({ doctorId: d, category: "dental", basis: "FIXED", amount: 1 })).res.status).toBe(422);
      expect((await setRule({ doctorId: receptionId, category: "*", basis: "FIXED", amount: 100 })).res.status).toBe(422);
      expect((await setRule({ doctorId: d, category: "*", basis: "FIXED", amount: 100 }, doctors.collected!.cookie)).res.status).toBe(403);
      expect((await rulesGet(request("/api/doctor-pay/rules", { cookie: receptionCookie }))).status).toBe(403);
      const list = await json(await rulesGet(request("/api/doctor-pay/rules", { cookie: ownerCookie })));
      expect(list.json.doctors.find((x: { id: string }) => x.id === d).rules.map((r: { category: string }) => r.category)).toEqual(["*", "laser"]);
      const laser = list.json.doctors.find((x: { id: string }) => x.id === d).rules.find((r: { category: string }) => r.category === "laser");
      expect((await ruleDelete(request(`/api/doctor-pay/rules/${laser.id}`, { method: "DELETE", cookie: ownerCookie }), params("id", laser.id))).status).toBe(200);
      expect(await db.auditLog.count({ where: { tenantId: a, action: { in: ["doctor_pay.rule_create", "doctor_pay.rule_update", "doctor_pay.rule_delete"] } } })).toBe(3);
    });
  });

  describe("statements", () => {
    it("a share of what is collected, the costs first, never below zero; money collected later counts in its month", async () => {
      const d = doctors.collected!.id;
      await backdateRules(d);
      const p1 = await patient("Salma Nour");
      const w1 = await done({ patientId: p1, doctorId: d, treatment: "hair-transplant", price: 10_000, at: on(M3, 10) });
      await db.procedureCost.create({ data: { tenantId: a, procedureId: w1.id, kind: "LAB", description: "Lab", amount: 1_000, incurredAt: on(M3, 11) } });
      await billAndPay(p1, w1.charges, on(M3, 10, 13), [
        [4_000, on(M3, 12)],
        [6_000, on(M2, 5)],
      ]);
      // Costs above what came in: nothing, never less.
      const p2 = await patient("Omar Nour");
      const w2 = await done({ patientId: p2, doctorId: d, treatment: "acne", price: 1_000, at: on(M3, 15) });
      await db.procedureCost.create({ data: { tenantId: a, procedureId: w2.id, kind: "MATERIAL", description: "Kit", amount: 1_500, incurredAt: on(M3, 15) } });
      await billAndPay(p2, w2.charges, on(M3, 15, 13), [[1_000, on(M3, 15, 14)]]);

      const first = await statement(d, M3);
      expect(first.res.status, JSON.stringify(first.json)).toBe(200);
      expect(first.json.statement).toMatchObject({ status: "OPEN", ended: true, billed: 11_000, collected: 5_000, costs: 2_500, earned: 1_200, payable: 1_200, unruled: 0 });
      const line = first.json.statement.lines.find((l: { procedureId: string }) => l.procedureId === w1.id);
      expect(line).toMatchObject({ billedToDate: 10_000, collectedToDate: 4_000, costsToDate: 1_000, earnedToDate: 1_200, paidBefore: 0, due: 1_200 });
      expect(first.json.statement.lines.find((l: { procedureId: string }) => l.procedureId === w2.id)).toMatchObject({ earnedToDate: 0, due: 0 });
      expect((await close(d, M3)).json.statement).toMatchObject({ status: "CLOSED", payable: 1_200 });

      // The rest came in the month after: what it earned less what was paid.
      const second = (await statement(d, M2)).json.statement;
      expect(second).toMatchObject({ status: "OPEN", collected: 6_000, earned: 2_400, payable: 2_400 });
      expect(second.lines).toHaveLength(1);
      expect(second.lines[0]).toMatchObject({ procedureId: w1.id, collectedInMonth: 6_000, collectedToDate: 10_000, earnedToDate: 3_600, paidBefore: 1_200, due: 2_400 });
    });

    it("per category: a fee a session, a share of what is billed with the price list's materials off, consultation fees; work no rule covers earns nothing", async () => {
      const d = doctors.billed!.id;
      await setRule({ doctorId: d, category: "laser", basis: "FIXED", amount: 250 });
      await setRule({ doctorId: d, category: "injectables", basis: "BILLED", percent: 35 });
      await setRule({ doctorId: d, category: "consultation", basis: "FIXED", amount: 150 });
      await backdateRules(d);
      const p = await patient("Hoda Nour");
      await done({ patientId: p, doctorId: d, treatment: "laser-hair-removal", price: 6_000, stages: 6, at: on(M2, 3), sessions: [on(M2, 3), on(M2, 24)] });
      await done({ patientId: p, doctorId: d, treatment: "botox-fillers", priceItemId: injectable, quantity: 2, price: 4_000, at: on(M2, 8) });
      await done({ patientId: p, doctorId: d, treatment: "general-dermatology", price: 800, at: on(M2, 9) });
      const visit = await db.appointment.create({ data: { tenantId: a, clinicId: branch, patientId: p, doctorId: d, startsAt: on(M2, 9, 10), endsAt: on(M2, 9, 11), kind: "CONSULTATION", status: "COMPLETED" } });
      await db.payment.create({ data: { tenantId: a, patientId: p, kind: "CONSULTATION_FEE", method: "CASH", amount: 600, paidAt: on(M2, 9, 11), appointmentId: visit.id, clinicId: branch } });

      const s = (await statement(d, M2)).json.statement;
      const by = (re: RegExp) => s.lines.find((l: { description: string; categoryLabel: string }) => re.test(`${l.categoryLabel} ${l.description}`));
      expect(by(/^Laser/)).toMatchObject({ sessionsToDate: 2, billedToDate: 2_000, earnedToDate: 500, terms: { basis: "FIXED", amount: 250 } });
      expect(by(/^Injectables/)).toMatchObject({ billedToDate: 4_000, costsToDate: 1_000, earnedToDate: 1_050 });
      expect(by(/^Consultation fees/)).toMatchObject({ billedToDate: 600, earnedToDate: 150 });
      expect(by(/^General/)).toMatchObject({ terms: null, earnedToDate: 0 });
      expect(s).toMatchObject({ earned: 1_700, unruled: 1 });
    });

    it("work paid for and then cancelled is taken back: owed back is carried to the next month and taken off it", async () => {
      const d = doctors.back!.id;
      await setRule({ doctorId: d, category: "*", basis: "BILLED", percent: 50, deductCosts: false });
      await backdateRules(d);
      const p = await patient("Rana Nour");
      const w = await done({ patientId: p, doctorId: d, treatment: "acne", price: 2_000, at: on(M3, 6) });
      expect((await close(d, M3)).json.statement).toMatchObject({ earned: 1_000, payable: 1_000 });
      // Cancelled the month after: the charge reversed.
      await db.charge.create({ data: { tenantId: a, patientId: p, procedureId: w.id, amount: -2_000, description: "Reversed", chargedAt: on(M2, 3), doctorId: d, clinicId: branch, reversalOfId: w.charges[0]!.id } });
      const back = (await close(d, M2)).json.statement;
      expect(back).toMatchObject({ billed: -2_000, earned: -1_000, payable: 0, carriedForward: -1_000 });
      expect(back.lines[0]).toMatchObject({ earnedToDate: 0, paidBefore: 1_000, due: -1_000 });
      await done({ patientId: p, doctorId: d, treatment: "acne", price: 3_000, at: on(M1, 4) });
      expect((await statement(d, M1)).json.statement).toMatchObject({ earned: 1_500, broughtForward: -1_000, payable: 500, carriedForward: 0 });
    });

    it("closes months that are over, in order; a closed one never changes but to be marked paid, once", async () => {
      const d = doctors.order!.id;
      await setRule({ doctorId: d, category: "*", basis: "BILLED", percent: 10, deductCosts: false });
      await backdateRules(d);
      const p = await patient("Laila Nour");
      await done({ patientId: p, doctorId: d, treatment: "acne", price: 5_000, at: on(M3, 7) });
      await done({ patientId: p, doctorId: d, treatment: "acne", price: 7_000, at: on(M2, 7) });
      const current = await close(d, thisMonth);
      expect(current.res.status).toBe(409);
      expect(current.json.error).toBe("not_ended");
      // Closing the later month first covers the earlier one.
      expect((await close(d, M2)).json.statement).toMatchObject({ earned: 1_200, payable: 1_200, periodStart: on(M3, 1, 0).toISOString() });
      const covered = await statement(d, M3);
      expect(covered.json.statement).toMatchObject({ status: "COVERED", coveredBy: M2 });
      expect((await close(d, M3)).res.status).toBe(409);
      expect((await close(d, M2)).res.status).toBe(409);
      expect((await close(d, "2026-13")).res.status).toBe(422);
      // Paid, once.
      expect((await markPaid(d, { month: M2, method: "BANK_TRANSFER", reference: "CIB 77" }, doctors.order!.cookie)).res.status).toBe(403);
      const paid = await markPaid(d, { month: M2, method: "BANK_TRANSFER", reference: "CIB 77" });
      expect(paid.json.statement).toMatchObject({ status: "PAID", paidMethod: "BANK_TRANSFER", paidReference: "CIB 77" });
      expect((await markPaid(d, { month: M2 })).res.status).toBe(409);
      expect((await markPaid(d, { month: M1 })).res.status).toBe(409);
      // The database keeps it as closed.
      const stored = await db.doctorStatement.findFirstOrThrow({ where: { tenantId: a, doctorId: d, month: M2 }, include: { lines: true } });
      await expect(db.doctorStatement.update({ where: { id: stored.id }, data: { earned: 1 } })).rejects.toThrow(/never changes/);
      await expect(db.doctorStatement.delete({ where: { id: stored.id } })).rejects.toThrow(/never deleted/);
      await expect(db.doctorStatementLine.update({ where: { id: stored.lines[0]!.id }, data: { due: 1 } })).rejects.toThrow(/never change/);
      expect(await db.auditLog.count({ where: { tenantId: a, action: { in: ["doctor_pay.close", "doctor_pay.paid"] }, entityId: stored.id } })).toBe(2);
    });

    it("a doctor reads their own statement only; the owner reads every one; another clinic none", async () => {
      const own = await statement(doctors.billed!.id, M2, doctors.billed!.cookie);
      expect(own.res.status).toBe(200);
      expect((await statement(doctors.collected!.id, M2, doctors.billed!.cookie)).res.status).toBe(403);
      expect((await statement(doctors.collected!.id, M2, receptionCookie)).res.status).toBe(403);
      expect((await statement(doctors.collected!.id, M2, ownerBCookie)).res.status).toBe(404);
      const overview = await json(await overviewGet(request(`/api/doctor-pay/statements?month=${M2}`, { cookie: ownerCookie })));
      expect(overview.json.rows.map((r: { doctor: { id: string } }) => r.doctor.id).sort()).toEqual(Object.values(doctors).map((x) => x.id).sort());
      expect((await overviewGet(request(`/api/doctor-pay/statements?month=${M2}`, { cookie: doctors.billed!.cookie }))).status).toBe(403);
    });
  });

  describe("procedure costs", () => {
    it("the desk adds a lab bill or materials; the owner voids one with a reason; the database keeps them", async () => {
      const p = await patient("Mona Nour");
      const w = await done({ patientId: p, doctorId: doctors.collected!.id, treatment: "acne", price: 1_500, at: on(M1, 5) });
      const add = (body: Record<string, unknown>, cookie = receptionCookie) => costPost(request(`/api/procedures/${w.id}/costs`, { method: "POST", cookie, body }), params("id", w.id)).then(json);
      const made = await add({ kind: "LAB", description: "Histopathology", amount: 900 });
      expect(made.res.status, JSON.stringify(made.json)).toBe(201);
      expect(made.json.cost).toMatchObject({ kind: "LAB", amount: 900, voidedAt: null });
      expect((await add({ kind: "LAB", description: "x", amount: 900 })).res.status).toBe(422);
      expect((await add({ kind: "LAB", description: "Lab", amount: 0 })).res.status).toBe(422);
      expect((await add({ kind: "LAB", description: "Lab", amount: 100, incurredOn: "2999-01-01" })).res.status).toBe(422);
      expect((await add({ kind: "LAB", description: "Lab", amount: 100 }, doctors.collected!.cookie)).res.status).toBe(403);
      expect((await add({ kind: "LAB", description: "Lab", amount: 100 }, ownerBCookie)).res.status).toBe(404);
      const id = made.json.cost.id;
      const voidIt = (cookie: string, reason = "Entered twice") => costVoid(request(`/api/procedure-costs/${id}/void`, { method: "POST", cookie, body: { reason } }), params("id", id)).then(json);
      expect((await voidIt(receptionCookie)).res.status).toBe(403);
      expect((await voidIt(ownerCookie)).json.cost).toMatchObject({ voidReason: "Entered twice" });
      expect((await voidIt(ownerCookie)).res.status).toBe(409);
      await expect(db.procedureCost.update({ where: { id }, data: { amount: 1 } })).rejects.toThrow(/never changes/);
      await expect(db.procedureCost.delete({ where: { id } })).rejects.toThrow(/never deleted/);
      expect(await db.auditLog.count({ where: { tenantId: a, entityId: w.id, action: { in: ["procedure.cost_add", "procedure.cost_void"] } } })).toBe(2);
    });

    it("the price list keeps the materials per unit", async () => {
      const res = await json(await pricePatch(request(`/api/prices/${injectable}`, { method: "PATCH", cookie: ownerCookie, body: { materialCost: 650 } }), params("id", injectable)));
      expect(res.res.status, JSON.stringify(res.json)).toBe(200);
      expect(res.json.item.materialCost).toBe(650);
    });
  });
});

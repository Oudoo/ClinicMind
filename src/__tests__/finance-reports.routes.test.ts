/**
 * The owner's financial reports over the real route handlers and the test
 * database. One clinic with two branches and two doctors goes through a
 * week of work built with the app's own routes: a procedure discounted at
 * the desk, a course whose discount is spread over its sessions, an invoice
 * with a line discount, a payment and a write-off, a deposit and a refund, a
 * consultation fee, a voided payment, a cancelled procedure, an invoice
 * cancelled by credit note, a planned procedure and an older course still
 * under way. Every report must count it the same way: production from the
 * charges (gross, discounts, cancelled, fees, net), income from the money,
 * branches and doctors adding up to the totals, every adjustment with its
 * reason and who made it, balances by age, procedures with their progress,
 * and the CSV of each. RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enrol = vi.hoisted(() => vi.fn(async () => ({ enrolmentId: "enr-test", protocolId: "prot-test", tasks: 0 })));
vi.mock("@/modules/concierge/service", () => ({ enrolOnSignedProcedure: enrol }));

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, fromDateKey } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { procedureDiscountShare, splitByWeight } from "@/modules/finance/reports";
import { POST as createProcedureRoute } from "@/app/api/procedures/route";
import { POST as signRoute } from "@/app/api/procedures/[id]/sign/route";
import { POST as cancelProcedureRoute } from "@/app/api/procedures/[id]/cancel/route";
import { POST as startRoute } from "@/app/api/procedures/[id]/start/route";
import { POST as stageRoute } from "@/app/api/procedures/[id]/stages/route";
import { POST as draftRoute } from "@/app/api/invoices/route";
import { POST as issueRoute } from "@/app/api/invoices/[id]/issue/route";
import { POST as cancelInvoiceRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as discountRoute } from "@/app/api/invoices/[id]/discount/route";
import { POST as writeOffRoute } from "@/app/api/invoices/[id]/write-off/route";
import { POST as paymentRoute } from "@/app/api/payments/route";
import { POST as voidRoute } from "@/app/api/payments/[id]/void/route";
import { GET as reportRoute } from "@/app/api/finance/reports/[report]/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, openShifts, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const params = <T extends string>(key: T, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<T, string>) });
const MIN = 60_000;

describe("report arithmetic (pure)", () => {
  it("spreads a course's own discount over its sessions as its price is, the rest on what is left at the signature", () => {
    const course = { price: 8_000, discount: 800, stages: 4, charges: [] as { stage: number | null; reversalOfId: string | null; discountOfId: string | null }[] };
    expect([1, 2, 3, 4].map((stage) => procedureDiscountShare(course, { stage }))).toEqual([200, 200, 200, 200]);
    const twoDone = { ...course, charges: [1, 2].map((stage) => ({ stage, reversalOfId: null, discountOfId: null })) };
    expect(procedureDiscountShare(twoDone, { stage: null })).toBe(400);
    const odd = { price: 10_000, discount: 1_001, stages: 3, charges: [] };
    expect([1, 2, 3].reduce((s, stage) => s + procedureDiscountShare(odd, { stage }), 0)).toBe(1_001);
    expect(procedureDiscountShare({ price: 2_000, discount: 2_000, stages: 1, charges: [] }, { stage: null })).toBe(2_000);
    expect(procedureDiscountShare({ price: 2_000, discount: 0, stages: 1, charges: [] }, { stage: null })).toBe(0);
  });

  it("shares money over the doctors' lines in whole pounds that add up", () => {
    expect(Object.fromEntries(splitByWeight(1_000, new Map([["a", 1], ["b", 1], ["c", 1]])))).toEqual({ a: 334, b: 333, c: 333 });
    expect([...splitByWeight(5_000, new Map([["a", 8_500]])).values()]).toEqual([5_000]);
    const shares = splitByWeight(1_701, new Map([["a", 7_200], ["b", 1_800]]));
    expect((shares.get("a") ?? 0) + (shares.get("b") ?? 0)).toBe(1_701);
    expect(shares.get("a")).toBe(1_361);
  });
});

describe.skipIf(!dbTestsEnabled)("finance report routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let tz: string;
  let zamalek: string;
  let dokki: string;
  let omar: string;
  let mariam: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let dokkiDeskCookie: string;
  let omarCookie: string;
  let mariamCookie: string;
  let ownerBCookie: string;
  const patient: Record<"p1" | "p2" | "p3" | "p4", string> = { p1: "", p2: "", p3: "", p4: "" };
  const invoice: Record<"p1" | "p2" | "p3", string> = { p1: "", p2: "", p3: "" };
  let p1Number: string;
  let creditNote: string;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const post = (route: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, body: unknown, cookie: string) =>
    route(request(path, { method: "POST", cookie, body }), params("id", id)).then(json);
  const procedure = async (body: Record<string, unknown>, cookie = ownerCookie) => {
    const made = await createProcedureRoute(request("/api/procedures", { method: "POST", cookie, body })).then(json);
    expect(made.res.status).toBe(201);
    return made.json.procedure.id as string;
  };
  const sign = async (id: string, cookie: string) => expect((await post(signRoute, `/api/procedures/${id}/sign`, id, undefined, cookie)).res.status).toBe(200);
  const pay = async (body: Record<string, unknown>, cookie = receptionCookie) => {
    const made = await paymentRoute(request("/api/payments", { method: "POST", cookie, body: { method: "CASH", kind: "PAYMENT", ...body } })).then(json);
    expect(made.res.status).toBe(201);
    return made.json.payment.id as string;
  };
  const draft = async (patientId: string, cookie = receptionCookie) => {
    const made = await draftRoute(request("/api/invoices", { method: "POST", cookie, body: { patientId } })).then(json);
    expect(made.res.status).toBe(201);
    return made.json.invoice as { id: string; lines: { chargeId: string; amount: number }[] };
  };
  const issue = async (id: string) => {
    const done = await post(issueRoute, `/api/invoices/${id}/issue`, id, undefined, receptionCookie);
    expect(done.res.status).toBe(200);
    return done.json.invoice as { number: string };
  };
  const report = (key: string, query: Record<string, string> = {}, cookie = ownerCookie) =>
    reportRoute(request(`/api/finance/reports/${key}?${new URLSearchParams({ period: "7d", ...query }).toString()}`, { cookie }), params("report", key)).then(json);
  const dayKey = (offset: number) => dateKeyInTz(addDays(new Date(), offset, tz), tz);
  const at = (offset: number, hour: number) => new Date(fromDateKey(dayKey(offset), tz)!.getTime() + hour * 3_600_000);

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `rep-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `rep-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    tz = await getTenantTimezone(a);
    zamalek = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    await db.clinic.update({ where: { id: zamalek }, data: { name: "Test Clinic — Zamalek" } });
    dokki = (await db.clinic.create({ data: { tenantId: a, name: "Test Clinic — Dokki" } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk Zamalek" });
    const dokkiDesk = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk Dokki" });
    omar = (await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Omar" })).id;
    mariam = (await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Mariam" })).id;
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    dokkiDeskCookie = await sessionCookieFor(dokkiDesk.id);
    omarCookie = await sessionCookieFor(omar);
    mariamCookie = await sessionCookieFor(mariam);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await openShifts(a, [reception.id], zamalek);
    await openShifts(a, [dokkiDesk.id, owner.id], dokki);
    await ensureDefaultTreatments(a);
    const acne = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "acne" } })).id;
    const laser = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "laser-hair-removal" } })).id;
    const course = (
      await db.priceItem.create({
        data: { tenantId: a, code: "LHR-4", name: "Laser course", category: "laser", unit: "PACKAGE", sessions: 4, treatmentId: laser, prices: { create: { tenantId: a, amount: 8_000, effectiveFrom: new Date(Date.now() - 400 * 86_400_000) } } },
      })
    ).id;
    const person = async (fullName: string, phone: string) => (await db.patient.create({ data: { tenantId: a, fullName, phone } })).id;
    patient.p1 = await person("Report One", "+201007770001");
    patient.p2 = await person("Report Two", "+201007770002");
    patient.p3 = await person("Report Three", "+201007770003");
    patient.p4 = await person("Report Four", "+201007770004");
    const visit = async (patientId: string, clinicId: string, doctorId: string) =>
      (await db.appointment.create({ data: { tenantId: a, patientId, clinicId, doctorId, startsAt: new Date(Date.now() - 90 * MIN), endsAt: new Date(Date.now() - 60 * MIN), status: "COMPLETED" } })).id;

    // P1 at Zamalek, Dr. Omar: 10,000 less 10% at the desk, signed; invoiced with 500 more off a line; 5,000 paid; 1,000 written off.
    const p1Work = await procedure({ patientId: patient.p1, treatmentId: acne, doctorId: omar, performedAt: new Date(Date.now() - 60 * MIN).toISOString(), price: 10_000, discount: 1_000, discountReason: "LOYALTY" }, receptionCookie);
    await sign(p1Work, omarCookie);
    await procedure({ patientId: patient.p1, treatmentId: acne, doctorId: omar, performedAt: new Date(Date.now() - 30 * MIN).toISOString(), price: 3_000 });
    const p1Draft = await draft(patient.p1);
    expect((await post(discountRoute, `/api/invoices/${p1Draft.id}/discount`, p1Draft.id, { chargeId: p1Draft.lines[0]!.chargeId, amount: 500, reason: "GOODWILL" }, receptionCookie)).res.status).toBe(200);
    invoice.p1 = p1Draft.id;
    p1Number = (await issue(p1Draft.id)).number;
    await pay({ patientId: patient.p1, amount: 5_000 });
    expect((await post(writeOffRoute, `/api/invoices/${invoice.p1}/write-off`, invoice.p1, { amount: 1_000, reason: "SMALL_BALANCE", note: "Agreed at the desk" }, ownerCookie)).res.status).toBe(200);

    // P2 at Dokki, Dr. Mariam: a four-session course, 8,000 less 800; a deposit, part refunded; two sessions, then signed; invoiced.
    const p2Visit = await visit(patient.p2, dokki, mariam);
    const p2Course = await procedure({ patientId: patient.p2, priceItemId: course, doctorId: mariam, appointmentId: p2Visit, performedAt: new Date(Date.now() - 60 * MIN).toISOString(), discount: 800, discountReason: "PACKAGE" }, dokkiDeskCookie);
    await pay({ patientId: patient.p2, kind: "DEPOSIT", method: "BANK_TRANSFER", amount: 2_000, procedureId: p2Course }, dokkiDeskCookie);
    await pay({ patientId: patient.p2, kind: "REFUND", amount: 300, note: "Deposit taken twice over" }, ownerCookie);
    expect((await post(startRoute, `/api/procedures/${p2Course}/start`, p2Course, { startedAt: dayKey(-1) }, dokkiDeskCookie)).res.status).toBe(200);
    for (const minutes of [20, 10]) {
      expect((await post(stageRoute, `/api/procedures/${p2Course}/stages`, p2Course, { performedAt: new Date(Date.now() - minutes * MIN).toISOString() }, mariamCookie)).res.status).toBe(200);
    }
    await sign(p2Course, mariamCookie);
    invoice.p2 = (await draft(patient.p2, dokkiDeskCookie)).id;
    await issue(invoice.p2);

    // P3 at Zamalek: a consultation fee at a Dokki visit (Dr. Omar's), taken at the Dokki desk; a payment voided; work cancelled; an invoice cancelled.
    await pay({ patientId: patient.p3, kind: "CONSULTATION_FEE", method: "CARD", amount: 500, appointmentId: await visit(patient.p3, dokki, omar) }, dokkiDeskCookie);
    const twice = await pay({ patientId: patient.p3, amount: 100 });
    expect((await post(voidRoute, `/api/payments/${twice}/void`, twice, { reason: "Entered twice" }, ownerCookie)).res.status).toBe(200);
    const wrong = await procedure({ patientId: patient.p3, treatmentId: acne, doctorId: mariam, performedAt: new Date(Date.now() - 50 * MIN).toISOString(), price: 1_200 });
    await sign(wrong, mariamCookie);
    expect((await post(cancelProcedureRoute, `/api/procedures/${wrong}/cancel`, wrong, { reason: "Recorded on the wrong patient" }, ownerCookie)).res.status).toBe(200);
    const small = await procedure({ patientId: patient.p3, treatmentId: acne, doctorId: omar, performedAt: new Date(Date.now() - 40 * MIN).toISOString(), price: 600 });
    await sign(small, omarCookie);
    invoice.p3 = (await draft(patient.p3)).id;
    await issue(invoice.p3);
    const cancelled = await post(cancelInvoiceRoute, `/api/invoices/${invoice.p3}/cancel`, invoice.p3, { reason: "Issued to the wrong patient" }, ownerCookie);
    expect(cancelled.res.status).toBe(200);
    creditNote = (await db.creditNote.findFirstOrThrow({ where: { invoiceId: invoice.p3 } })).number;

    // P4: a course started ten days ago, one session done then: still under way, outside the week.
    const old = await procedure({ patientId: patient.p4, priceItemId: course, doctorId: mariam, performedAt: at(-10, 9).toISOString() });
    expect((await post(startRoute, `/api/procedures/${old}/start`, old, { startedAt: dayKey(-10) }, receptionCookie)).res.status).toBe(200);
    expect((await post(stageRoute, `/api/procedures/${old}/stages`, old, { performedAt: at(-10, 12).toISOString() }, mariamCookie)).res.status).toBe(200);

    // Tenant B has work of its own.
    const patientB = (await db.patient.create({ data: { tenantId: b, fullName: "Patient Of B", phone: "+201007770009" } })).id;
    await db.charge.create({ data: { tenantId: b, patientId: patientB, amount: 9_999, description: "B's work", chargedAt: new Date(Date.now() - 60 * MIN) } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("counts production from the charges: gross before discounts, the discounts, cancelled work, fees, net", async () => {
    const { res, json: r } = await report("production");
    expect(res.status).toBe(200);
    expect(r.totals).toEqual({ gross: 19_800, discounts: -2_300, cancelled: -1_200, fees: 500, net: 16_800, procedures: 6 });
    const charged = await db.charge.aggregate({ where: { tenantId: a }, _sum: { amount: true } });
    const olderCourse = await db.charge.aggregate({ where: { tenantId: a, patientId: patient.p4 }, _sum: { amount: true } });
    // Net production is what the accounts were charged in the week, and the fees.
    expect(r.totals.net).toBe((charged._sum.amount ?? 0) - (olderCourse._sum.amount ?? 0) + 500);
    const days = r.days as { date: string; net: number }[];
    expect(days).toHaveLength(7);
    expect(days.reduce((s, d) => s + d.net, 0)).toBe(16_800);
    expect(r.byTreatment).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Consultation fees", net: 500 })]));
    // One branch at a time.
    expect((await report("production", { clinicId: dokki })).json.totals).toEqual({ gross: 8_000, discounts: -800, cancelled: 0, fees: 500, net: 7_700, procedures: 3 });
    expect((await report("production", { clinicId: zamalek })).json.totals).toEqual({ gross: 11_800, discounts: -1_500, cancelled: -1_200, fees: 0, net: 9_100, procedures: 3 });
  });

  it("counts income from the money in, less refunds, by method; voided payments never count", async () => {
    const { json: r } = await report("income");
    expect(r.totals).toEqual({ payments: 5_000, deposits: 2_000, fees: 500, insurers: 0, refunds: -300, net: 7_200, methods: { CASH: 4_700, BANK_TRANSFER: 2_000, CARD: 500 }, receipts: 4 });
    expect(r.methods.map((m: { method: string }) => m.method)).toEqual(["CASH", "CARD", "BANK_TRANSFER"]);
    const today = (r.days as { date: string; net: number; signedOff: string | null }[]).filter((d) => d.net !== 0);
    expect(today.every((d) => d.signedOff === "no")).toBe(true);
    expect((await report("income", { clinicId: dokki })).json.totals).toMatchObject({ net: 2_200, payments: 0, deposits: 2_000, fees: 500, refunds: -300 });
    expect((await report("income", { clinicId: zamalek })).json.totals).toMatchObject({ net: 5_000, receipts: 1 });
  });

  it("puts the branches side by side, adding up to the clinic", async () => {
    const { json: r } = await report("branches", { clinicId: dokki });
    const row = (id: string) => r.rows.find((x: { clinicId: string }) => x.clinicId === id);
    expect(r.rows).toHaveLength(2);
    expect(row(zamalek)).toMatchObject({ name: "Test Clinic — Zamalek", gross: 11_800, discounts: -1_500, cancelled: -1_200, fees: 0, net: 9_100, income: 5_000, writtenOff: 1_000 });
    expect(row(dokki)).toMatchObject({ name: "Test Clinic — Dokki", gross: 8_000, discounts: -800, fees: 500, net: 7_700, income: 2_200, writtenOff: 0 });
    expect(r.totals).toMatchObject({ net: 16_800, income: 7_200, writtenOff: 1_000 });
  });

  it("lists every adjustment with its reason and who made it", async () => {
    const { json: r } = await report("adjustments");
    expect(r.totals).toEqual({
      DISCOUNT: { count: 5, amount: -2_300 },
      WRITE_OFF: { count: 1, amount: -1_000 },
      CANCELLED: { count: 1, amount: -1_200 },
      REFUND: { count: 1, amount: -300 },
      VOID: { count: 1, amount: -100 },
      CREDIT_NOTE: { count: 1, amount: -600 },
    });
    const find = (type: string, amount: number) => r.rows.find((x: { type: string; amount: number }) => x.type === type && x.amount === amount);
    expect(find("DISCOUNT", -1_000)).toMatchObject({ patientName: "Report One", reason: "Returning patient", by: "Desk Zamalek" });
    expect(find("DISCOUNT", -500)).toMatchObject({ reason: "Goodwill (a complaint or a long wait)", by: "Desk Zamalek" });
    expect(r.rows.filter((x: { type: string; patientName: string }) => x.type === "DISCOUNT" && x.patientName === "Report Two").map((x: { amount: number }) => x.amount).sort()).toEqual([-200, -200, -400]);
    expect(find("WRITE_OFF", -1_000)).toMatchObject({ reason: "Too small to chase: Agreed at the desk", by: "Owner A", reference: p1Number });
    expect(find("CANCELLED", -1_200)).toMatchObject({ patientName: "Report Three", reason: "Recorded on the wrong patient", by: "Owner A" });
    expect(find("REFUND", -300)).toMatchObject({ reason: "Deposit taken twice over", by: "Owner A" });
    expect(find("VOID", -100)).toMatchObject({ reason: "Entered twice", by: "Owner A" });
    expect(find("CREDIT_NOTE", -600)).toMatchObject({ reason: "Issued to the wrong patient", by: "Owner A", reference: creditNote });
    const discounts = await report("adjustments", { type: "DISCOUNT" });
    expect(discounts.json.rows).toHaveLength(5);
    expect(discounts.json.totals.VOID).toEqual({ count: 1, amount: -100 });
    expect((await report("adjustments", { clinicId: dokki })).json.totals).toMatchObject({ DISCOUNT: { count: 3, amount: -800 }, REFUND: { count: 1, amount: -300 }, VOID: { count: 0, amount: 0 } });
  });

  it("says what every patient owes now, due on invoices by age, and the invoices of the period", async () => {
    const { json: r } = await report("balances");
    const p2Paid = (await db.paymentAllocation.aggregate({ where: { invoiceId: invoice.p2 }, _sum: { amount: true } }))._sum.amount ?? 0;
    expect(p2Paid).toBe(1_700);
    const row = (id: string) => r.rows.find((x: { patientId: string }) => x.patientId === id);
    expect(row(patient.p1)).toMatchObject({ balance: 2_500, dueOnInvoices: 2_500, notInvoiced: 0, credit: 0, aging: [2_500, 0, 0, 0] });
    expect(row(patient.p2)).toMatchObject({ balance: 5_500, dueOnInvoices: 5_500, notInvoiced: 0, credit: 0 });
    expect(row(patient.p3)).toMatchObject({ balance: 600, dueOnInvoices: 0, notInvoiced: 600, credit: 0 });
    expect(row(patient.p4)).toMatchObject({ balance: 2_000, notInvoiced: 2_000 });
    expect(r.totals).toMatchObject({ owed: 10_600, owing: 4, credit: 0, dueOnInvoices: 8_000, notInvoiced: 2_600, aging: [8_000, 0, 0, 0] });
    expect(r.invoices).toMatchObject({ issued: 3, issuedTotal: 8_500 + 7_200, paid: 5_000 + 1_700, writtenOff: 1_000, due: 2_500 + 5_500, cancelled: 1 });
    expect(r.invoices.rows.map((i: { id: string; status: string }) => [i.id, i.status])).toEqual(
      expect.arrayContaining([
        [invoice.p1, "PART_PAID"],
        [invoice.p2, "PART_PAID"],
        [invoice.p3, "CANCELLED"],
      ]),
    );
    expect((await report("balances", { clinicId: dokki })).json.invoices.rows.map((i: { id: string }) => i.id)).toEqual([invoice.p2]);
  });

  it("tracks the procedures of the week and every course under way, with what is charged and invoiced", async () => {
    const { json: r } = await report("procedures");
    expect(r.counts).toEqual({ PLANNED: 1, STARTED: 1, SIGNED: 3, CANCELLED: 1 });
    const row = (patientId: string, status: string) => r.rows.find((x: { patientId: string; status: string }) => x.patientId === patientId && x.status === status);
    expect(row(patient.p2, "SIGNED")).toMatchObject({ label: "Laser course", doctorName: "Dr. Mariam", stages: 4, stagesDone: 4, net: 7_200, charged: 7_200, invoiced: 7_200, notInvoiced: 0 });
    expect(row(patient.p1, "SIGNED")).toMatchObject({ net: 9_000, charged: 8_500, invoiced: 8_500 });
    expect(row(patient.p3, "SIGNED")).toMatchObject({ net: 600, charged: 600, invoiced: 0, notInvoiced: 600 });
    expect(row(patient.p3, "CANCELLED")).toMatchObject({ charged: 0 });
    expect(row(patient.p4, "STARTED")).toMatchObject({ stagesDone: 1, stages: 4, charged: 2_000, notInvoiced: 2_000 });
    expect((await report("procedures", { status: "SIGNED" })).json.rows).toHaveLength(3);
    const mariams = (await report("procedures", { doctorId: mariam })).json.rows as { patientId: string }[];
    expect(mariams.map((x) => x.patientId).sort()).toEqual([patient.p2, patient.p3, patient.p4].sort());
    expect((await report("procedures", { clinicId: dokki })).json.rows.map((x: { patientId: string }) => x.patientId)).toEqual([patient.p2]);
  });

  it("gives each doctor's production, the money collected for their work and what was written off on it", async () => {
    const { json: r } = await report("providers");
    const row = (id: string) => r.rows.find((x: { doctorId: string }) => x.doctorId === id);
    expect(row(omar)).toMatchObject({ name: "Dr. Omar", gross: 10_600, discounts: -1_500, cancelled: 0, fees: 500, net: 9_600, procedures: 2, collected: 5_500, writtenOff: 1_000 });
    expect(row(mariam)).toMatchObject({ name: "Dr. Mariam", gross: 9_200, discounts: -800, cancelled: -1_200, fees: 0, net: 7_200, procedures: 4, collected: 1_700, writtenOff: 0 });
    expect(r.totals).toMatchObject({ net: 16_800, collected: 7_200, writtenOff: 1_000 });
    expect(r.rows.reduce((s: number, x: { net: number }) => s + x.net, 0)).toBe(r.totals.net);
  });

  it("closes a day: the drawer against the books, and every receipt traced to where its money went", async () => {
    const today = dayKey(0);
    const { res, json: r } = await report("day", { date: today });
    expect(res.status).toBe(200);
    expect(r.date).toBe(today);
    expect(r.branches.map((x: { name: string; signedOff: unknown; shifts: number; open: number }) => [x.name, x.signedOff, x.shifts, x.open])).toEqual([
      ["Test Clinic — Zamalek", null, 1, 1],
      ["Test Clinic — Dokki", null, 2, 2],
    ]);
    expect(r.income).toMatchObject({ net: 7_200, receipts: 4 });
    // The drawers hold what the payments say, method by method.
    expect(r.drawer).toEqual([
      { method: "CASH", label: "Cash", drawer: 4_700, books: 4_700, paidOut: 0 },
      { method: "CARD", label: "Card", drawer: 500, books: 500, paidOut: 0 },
      { method: "BANK_TRANSFER", label: "Bank transfer", drawer: 2_000, books: 2_000, paidOut: 0 },
    ]);
    expect(r.production.net).toBe((await report("production", { period: "custom", from: today, to: today })).json.totals.net);
    expect(r.summary).toEqual({ receipts: 4, onInvoices: 6_700, credit: 300, fees: 500, refunds: -300, untraced: 0 });
    const receipt = (kind: string) => r.trace.find((x: { kind: string }) => x.kind === kind);
    expect(receipt("PAYMENT")).toMatchObject({ amount: 5_000, traced: true, legs: [{ kind: "invoice", amount: 5_000, invoiceId: invoice.p1, invoiceNumber: p1Number, work: ["Acne treatment"] }] });
    expect(receipt("DEPOSIT").legs).toEqual([
      expect.objectContaining({ kind: "invoice", amount: 1_700, invoiceId: invoice.p2, work: ["Laser course · session 1 of 4", "Laser course · session 2 of 4", "Laser course · sessions 3–4 of 4"] }),
      expect.objectContaining({ kind: "credit", amount: 300, work: ["Laser course"] }),
    ]);
    expect(receipt("CONSULTATION_FEE").legs).toEqual([expect.objectContaining({ kind: "fee", amount: 500, work: [expect.stringMatching(/^Visit of .+ with Dr\. Omar$/)] })]);
    expect(receipt("REFUND")).toMatchObject({ amount: -300, traced: true, legs: [{ kind: "refund", amount: -300 }] });
    expect(r.trace.every((x: { receiptNumber: string | null }) => x.receiptNumber)).toBe(true);
    const dokkiDay = (await report("day", { date: today, clinicId: dokki })).json;
    expect(dokkiDay.summary).toEqual({ receipts: 3, onInvoices: 1_700, credit: 300, fees: 500, refunds: -300, untraced: 0 });
    expect(dokkiDay.branches.map((x: { name: string }) => x.name)).toEqual(["Test Clinic — Dokki"]);
    // An impossible date is today's.
    expect((await report("day", { date: "2026-02-30" })).json.date).toBe(today);
  });

  it("downloads each report as CSV, audited", async () => {
    for (const key of ["day", "income", "production", "branches", "adjustments", "balances", "procedures", "providers"]) {
      const res = await reportRoute(request(`/api/finance/reports/${key}?period=7d&format=csv`, { cookie: ownerCookie }), params("report", key));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      const text = await res.text();
      expect(text.split("\r\n").length).toBeGreaterThan(2);
    }
    const production = await (await reportRoute(request(`/api/finance/reports/production?period=7d&format=csv`, { cookie: ownerCookie }), params("report", "production"))).text();
    expect(production).toContain("Total,19800,-2300,-1200,500,16800,6");
    const adjustments = await (await reportRoute(request(`/api/finance/reports/adjustments?period=7d&format=csv&type=VOID`, { cookie: ownerCookie }), params("report", "adjustments"))).text();
    expect(adjustments).toContain("Voided payment,Report Three");
    expect(await db.auditLog.count({ where: { tenantId: a, action: "finance.report.export" } })).toBe(10);
    const day = await (await reportRoute(request(`/api/finance/reports/day?date=${dayKey(0)}&format=csv`, { cookie: ownerCookie }), params("report", "day"))).text();
    expect(day).toContain(`${p1Number}: Acne treatment`);
  });

  it("is the owner's: other roles are refused, an unknown report is not found, another clinic's branch neither", async () => {
    expect((await report("income", {}, receptionCookie)).res.status).toBe(403);
    expect((await report("income", {}, omarCookie)).res.status).toBe(403);
    expect((await report("nonsense")).res.status).toBe(404);
    expect((await report("income", { clinicId: zamalek }, ownerBCookie)).res.status).toBe(404);
    const theirs = await report("production", {}, ownerBCookie);
    expect(theirs.res.status).toBe(200);
    expect(theirs.json.totals).toMatchObject({ gross: 9_999, net: 9_999 });
    expect((await report("adjustments", {}, ownerBCookie)).json.rows).toEqual([]);
    expect((await report("balances", {}, ownerBCookie)).json.rows.map((x: { patientName: string }) => x.patientName)).toEqual(["Patient Of B"]);
  });
});

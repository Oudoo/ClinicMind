/**
 * Finance over the real route handlers and the test database: procedures
 * (record with a deposit, edit while planned, sign → the concierge enrolment
 * contract, cancel), payments (record, balance, void by the owner only), the
 * finance summary and CSV export (owner only), and the POS CSV import
 * (preview with matching and problems, then confirm). RBAC, validation and
 * tenant isolation on every endpoint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enrol = vi.hoisted(() => vi.fn(async (_tenantId: string, procedureId: string) => ({ enrolmentId: `enr-${procedureId}`, protocolId: "prot-test", tasks: 7 })));
vi.mock("@/modules/concierge/service", () => ({ enrolOnSignedProcedure: enrol }));

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { normalisePhone, parseAmount, parseImportDate, parseImportRows, parseKind, parseMethod } from "@/modules/finance/imports";
import { netPaid, procedureBalance } from "@/modules/finance/constants";
import { GET as listProceduresRoute, POST as createProcedureRoute } from "@/app/api/procedures/route";
import { GET as getProcedureRoute, PATCH as patchProcedureRoute } from "@/app/api/procedures/[id]/route";
import { POST as signRoute } from "@/app/api/procedures/[id]/sign/route";
import { POST as cancelRoute } from "@/app/api/procedures/[id]/cancel/route";
import { GET as listPaymentsRoute, POST as createPaymentRoute } from "@/app/api/payments/route";
import { POST as voidRoute } from "@/app/api/payments/[id]/void/route";
import { POST as importRoute } from "@/app/api/payments/import/route";
import { POST as confirmRoute } from "@/app/api/payments/import/confirm/route";
import { GET as summaryRoute } from "@/app/api/finance/summary/route";
import { GET as exportRoute } from "@/app/api/finance/export/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, openShifts, request, runAsSystem, sessionCookieFor } from "@/test/db";

// Setup and checks call the services directly; the routes enter their own request scope.
runAsSystem();

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DAY = 86_400_000;

describe("POS import parsing (pure)", () => {
  it("reads Egyptian phones in every spelling, Arabic digits included", () => {
    expect(normalisePhone("0100 111 2233")).toBe("+201001112233");
    expect(normalisePhone("٠١٠٠١١١٢٢٣٣")).toBe("+201001112233");
    expect(normalisePhone("00201001112233")).toBe("+201001112233");
    expect(normalisePhone("+966 50 123 4567")).toBe("+966501234567");
    expect(normalisePhone("call me")).toBeNull();
  });

  it("reads dates on the clinic clock, amounts, kinds and methods", () => {
    expect(parseImportDate("2026-10-25 14:10", "Africa/Cairo")?.toISOString()).toBe("2026-10-25T11:10:00.000Z");
    expect(parseImportDate("25/10/2026", "UTC")?.toISOString()).toBe("2026-10-25T12:00:00.000Z");
    expect(parseImportDate("31/02/2026", "UTC")).toBeNull();
    expect(parseAmount("EGP 2,500.00")).toBe(2500);
    expect(parseAmount("٢٥٠٠")).toBe(2500);
    expect(parseKind("عربون")).toBe("DEPOSIT");
    expect(parseKind("Refund")).toBe("REFUND");
    expect(parseKind("consultation")).toBe("CONSULTATION_FEE");
    expect(parseKind("")).toBe("PAYMENT");
    expect(parseMethod("Visa")).toBe("CARD");
    expect(parseMethod("instapay")).toBe("INSTAPAY");
    expect(parseMethod("Cheque")).toBe("CHEQUE");
    expect(parseMethod("Vodafone wallet")).toBe("WALLET");
    expect(parseMethod("")).toBe("POS");
  });

  it("flags every unreadable cell with its line number", () => {
    const { rows } = parseImportRows("date,phone,amount\n2026-10-25,01001112233,500\nyesterday,0100,0\n", "UTC");
    expect(rows[0]).toMatchObject({ line: 2, amount: 500, problems: [] });
    expect(rows[1]!.line).toBe(3);
    expect(rows[1]!.problems).toEqual(["Unreadable date", "Unreadable phone number", "Unreadable or zero amount"]);
  });

  it("computes a balance from price, discount, payments, deposits and refunds", () => {
    const pays = [
      { kind: "DEPOSIT", amount: 5_000 },
      { kind: "PAYMENT", amount: 30_000 },
      { kind: "REFUND", amount: 1_000 },
    ];
    expect(netPaid(pays)).toBe(34_000);
    expect(procedureBalance(60_000, 5_000, pays)).toBe(21_000);
  });
});

describe.skipIf(!dbTestsEnabled)("finance routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let owner: { id: string };
  let doctor: { id: string };
  let reception: { id: string };
  let ownerCookie: string;
  let doctorCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let patientA: string;
  let patientA2: string;
  let patientB: string;
  let hairA: string;
  let acneA: string;
  let acneB: string;
  let procedureB: string;

  const post = async (route: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, body: unknown, cookie = ownerCookie) => {
    const res = await route(request(path, { method: "POST", cookie, body }), params(id));
    return { res, json: await res.json() };
  };
  const createProcedure = async (body: Record<string, unknown>, cookie = ownerCookie) => {
    const res = await createProcedureRoute(request("/api/procedures", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  };
  const recordPayment = async (body: Record<string, unknown>, cookie = ownerCookie) => {
    const res = await createPaymentRoute(request("/api/payments", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  };

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `fin-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `fin-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Omar" });
    reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    receptionCookie = await sessionCookieFor(reception.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await openShifts(a, [owner.id, reception.id]);
    await ensureDefaultTreatments(a);
    await ensureDefaultTreatments(b);
    const treatment = async (tenantId: string, key: string) => (await db.treatment.findFirstOrThrow({ where: { tenantId, key } })).id;
    hairA = await treatment(a, "hair-transplant");
    acneA = await treatment(a, "acne");
    acneB = await treatment(b, "acne");
    patientA = (await db.patient.create({ data: { tenantId: a, fullName: "Mona Adel", phone: "+201001112233" } })).id;
    patientA2 = (await db.patient.create({ data: { tenantId: a, fullName: "Ali Hassan", whatsapp: "01004445566" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b, fullName: "Patient Of B", phone: "+201001112233" } })).id;
    procedureB = (await db.procedure.create({ data: { tenantId: b, patientId: patientB, treatmentId: acneB, performedAt: new Date(), price: 2_000 } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  beforeEach(() => {
    enrol.mockClear();
  });

  describe("procedures", () => {
    let planned: string;

    it("records a planned procedure with a deposit, on the timeline and in the audit trail", async () => {
      const performedAt = new Date(Date.now() + 3 * DAY).toISOString();
      const { res, json } = await createProcedure({
        patientId: patientA,
        treatmentId: hairA,
        doctorId: doctor.id,
        performedAt,
        price: 60_000,
        discount: 5_000,
        discountReason: "PACKAGE",
        notes: "2,400 grafts",
        deposit: { amount: 5_000, method: "BANK_TRANSFER", reference: "TRF-1" },
      });
      expect(res.status).toBe(201);
      expect(json.procedure).toMatchObject({
        status: "PLANNED",
        price: 60_000,
        discount: 5_000,
        paid: 5_000,
        balance: 50_000,
        doctor: { id: doctor.id, fullName: "Dr. Omar" },
        treatment: { key: "hair-transplant" },
      });
      expect(json.procedure.payments).toEqual([expect.objectContaining({ kind: "DEPOSIT", amount: 5_000, method: "BANK_TRANSFER", reference: "TRF-1" })]);
      planned = json.procedure.id;
      const audits = await db.auditLog.findMany({ where: { tenantId: a, action: { in: ["procedure.create", "payment.record"] } } });
      expect(audits.map((x) => x.action).sort()).toEqual(["payment.record", "procedure.create"]);
      const events = await db.timelineEvent.findMany({ where: { tenantId: a, patientId: patientA, kind: "PAYMENT" } });
      expect(events.some((e) => e.title.includes("Deposit received"))).toBe(true);
    });

    it("rejects a discount above the price and a missing date (422)", async () => {
      const { res, json } = await createProcedure({ patientId: patientA, treatmentId: acneA, performedAt: new Date().toISOString(), price: 1_000, discount: 2_000 });
      expect(res.status).toBe(422);
      expect(json.issues.fieldErrors.discount).toBeDefined();
      const missing = await createProcedure({ patientId: patientA, treatmentId: acneA, price: 1_000 });
      expect(missing.res.status).toBe(422);
      expect(missing.json.issues.fieldErrors.performedAt).toBeDefined();
    });

    it("lets a doctor record a procedure but not take a deposit (payments:write)", async () => {
      const withDeposit = await createProcedure({ patientId: patientA, treatmentId: acneA, performedAt: new Date().toISOString(), price: 1_800, deposit: { amount: 500 } }, doctorCookie);
      expect(withDeposit.res.status).toBe(403);
      const plain = await createProcedure({ patientId: patientA, treatmentId: acneA, performedAt: new Date().toISOString(), price: 1_800 }, doctorCookie);
      expect(plain.res.status).toBe(201);
      expect((await createProcedure({ patientId: patientA, treatmentId: acneA, performedAt: new Date().toISOString(), price: 1_800 }, assistantCookie)).res.status).toBe(403);
    });

    it("keeps another clinic's patient, treatment and procedure out of reach (404)", async () => {
      expect((await createProcedure({ patientId: patientB, treatmentId: acneA, performedAt: new Date().toISOString(), price: 1_000 })).res.status).toBe(404);
      expect((await createProcedure({ patientId: patientA, treatmentId: acneB, performedAt: new Date().toISOString(), price: 1_000 })).res.status).toBe(404);
      expect((await getProcedureRoute(request(`/api/procedures/${procedureB}`, { cookie: ownerCookie }), params(procedureB))).status).toBe(404);
      expect((await post(signRoute, `/api/procedures/${procedureB}/sign`, procedureB, {}, doctorCookie)).res.status).toBe(404);
      expect((await post(cancelRoute, `/api/procedures/${procedureB}/cancel`, procedureB, { reason: "x" })).res.status).toBe(404);
      expect(enrol).not.toHaveBeenCalled();
    });

    it("edits a planned procedure", async () => {
      const res = await patchProcedureRoute(request(`/api/procedures/${planned}`, { method: "PATCH", cookie: receptionCookie, body: { price: 62_000 } }), params(planned));
      expect(res.status).toBe(200);
      expect((await res.json()).procedure).toMatchObject({ price: 62_000, balance: 52_000 });
    });

    it("signs: a clinician only, then the concierge enrolment contract is called with the procedure", async () => {
      expect((await post(signRoute, `/api/procedures/${planned}/sign`, planned, {}, receptionCookie)).res.status).toBe(403);
      const { res, json } = await post(signRoute, `/api/procedures/${planned}/sign`, planned, {}, doctorCookie);
      expect(res.status).toBe(200);
      expect(json.procedure).toMatchObject({ id: planned, status: "SIGNED", signedBy: { id: doctor.id } });
      expect(json.procedure.signedAt).toBeTruthy();
      expect(json.enrolment).toEqual({ enrolmentId: `enr-${planned}`, protocolId: "prot-test", tasks: 7 });
      expect(enrol).toHaveBeenCalledTimes(1);
      expect(enrol).toHaveBeenCalledWith(a, planned, expect.objectContaining({ id: doctor.id }));
      const event = await db.timelineEvent.findFirst({ where: { tenantId: a, refId: planned, kind: "PROCEDURE" } });
      expect(event?.title).toBe("Hair transplant performed by Dr Omar");
    });

    it("refuses to sign or edit a signed procedure again (409)", async () => {
      const again = await post(signRoute, `/api/procedures/${planned}/sign`, planned, {}, doctorCookie);
      expect(again.res.status).toBe(409);
      expect(again.json).toMatchObject({ error: "invalid_state", status: "SIGNED" });
      const edit = await patchProcedureRoute(request(`/api/procedures/${planned}`, { method: "PATCH", cookie: ownerCookie, body: { price: 1 } }), params(planned));
      expect(edit.status).toBe(409);
      expect(enrol).not.toHaveBeenCalled();
    });

    it("keeps the signature when the enrolment fails", async () => {
      const { json } = await createProcedure({ patientId: patientA2, treatmentId: acneA, performedAt: new Date().toISOString(), price: 2_000 });
      enrol.mockRejectedValueOnce(new Error("concierge down"));
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const signed = await post(signRoute, `/api/procedures/${json.procedure.id}/sign`, json.procedure.id, {}, ownerCookie);
      errors.mockRestore();
      expect(signed.res.status).toBe(200);
      expect(signed.json).toMatchObject({ procedure: { status: "SIGNED" }, enrolment: null });
    });

    it("cancels a planned procedure with a reason; a signed one only by a clinician", async () => {
      const { json } = await createProcedure({ patientId: patientA, treatmentId: acneA, performedAt: new Date().toISOString(), price: 1_500 });
      const id = json.procedure.id as string;
      expect((await post(cancelRoute, `/api/procedures/${id}/cancel`, id, {}, receptionCookie)).res.status).toBe(422);
      const cancelled = await post(cancelRoute, `/api/procedures/${id}/cancel`, id, { reason: "Patient travelling" }, receptionCookie);
      expect(cancelled.res.status).toBe(200);
      expect(cancelled.json.procedure).toMatchObject({ status: "CANCELLED", cancelReason: "Patient travelling" });
      expect((await post(cancelRoute, `/api/procedures/${planned}/cancel`, planned, { reason: "x" }, receptionCookie)).res.status).toBe(409);
    });

    it("lists a patient's procedures with their balances", async () => {
      const res = await listProceduresRoute(request(`/api/procedures?patientId=${patientA}&status=SIGNED`, { cookie: receptionCookie }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.procedures.map((p: { id: string }) => p.id)).toEqual([planned]);
      expect(json.procedures[0].balance).toBe(52_000);
    });

    describe("payments and balance", () => {
      let payment: string;

      it("lets reception record payments towards a procedure, and the balance follows (refunds, the owner's, add back)", async () => {
        const pay = await recordPayment({ patientId: patientA, procedureId: planned, kind: "PAYMENT", method: "CARD", amount: 30_000, reference: "POS-1", note: "First instalment" }, receptionCookie);
        expect(pay.res.status).toBe(201);
        expect(pay.json.payment).toMatchObject({ kind: "PAYMENT", amount: 30_000, method: "CARD", procedure: { id: planned } });
        expect(pay.json.payment.receiptNumber).toMatch(/^[A-Z]+\d*-RC-\d{6}$/);
        payment = pay.json.payment.id;
        // Money going back out is the owner's to give, with the reason.
        expect((await recordPayment({ patientId: patientA, procedureId: planned, kind: "REFUND", method: "CASH", amount: 1_000, note: "Overcharged" }, receptionCookie)).res.status).toBe(403);
        const noReason = await recordPayment({ patientId: patientA, procedureId: planned, kind: "REFUND", method: "CASH", amount: 1_000 });
        expect(noReason.res.status).toBe(422);
        expect(noReason.json.issues.fieldErrors.note).toBeDefined();
        const refund = await recordPayment({ patientId: patientA, procedureId: planned, kind: "REFUND", method: "CASH", amount: 1_000, note: "Overcharged for the anaesthetic" });
        expect(refund.res.status).toBe(201);
        expect(refund.json.payment.receiptNumber).toMatch(/-RF-\d{6}$/);
        const res = await getProcedureRoute(request(`/api/procedures/${planned}`, { cookie: ownerCookie }), params(planned));
        expect((await res.json()).procedure).toMatchObject({ paid: 34_000, balance: 23_000 });
      });

      it("notifies the owner of a large payment", async () => {
        // The notification is fire-and-forget after the response; give it a moment.
        const where = { tenantId: a, kind: "PAYMENT_RECORDED" as const, userId: owner.id };
        for (let i = 0; i < 40 && !(await db.notification.count({ where })); i++) await new Promise((r) => setTimeout(r, 50));
        const notifications = await db.notification.findMany({ where });
        expect(notifications.length).toBeGreaterThanOrEqual(1);
        expect(notifications[0]!.title).toContain("30,000 EGP");
      });

      it("validates payments (422) and keeps them inside the tenant (404)", async () => {
        expect((await recordPayment({ patientId: patientA, kind: "PAYMENT", amount: 0 })).res.status).toBe(422);
        expect((await recordPayment({ patientId: patientA, kind: "GIFT", amount: 10 })).res.status).toBe(422);
        expect((await recordPayment({ patientId: patientA, kind: "PAYMENT", amount: 12.5 })).res.status).toBe(422);
        expect((await recordPayment({ patientId: patientB, kind: "PAYMENT", amount: 100 })).res.status).toBe(404);
        expect((await recordPayment({ patientId: patientA, procedureId: procedureB, kind: "PAYMENT", amount: 100 })).res.status).toBe(404);
        // A procedure of another patient of the same clinic is refused as well.
        expect((await recordPayment({ patientId: patientA2, procedureId: planned, kind: "PAYMENT", amount: 100 })).res.status).toBe(404);
        expect((await recordPayment({ patientId: patientA, kind: "PAYMENT", amount: 100 }, assistantCookie)).res.status).toBe(403);
      });

      it("rejects a cross-origin payment", async () => {
        const res = await createPaymentRoute(request("/api/payments", { method: "POST", cookie: ownerCookie, body: { patientId: patientA, kind: "PAYMENT", amount: 100 }, headers: { origin: "https://evil.example" } }));
        expect(res.status).toBe(403);
      });

      it("lists payments for the front desk and the owner, not for read-only roles", async () => {
        const res = await listPaymentsRoute(request(`/api/payments?patientId=${patientA}`, { cookie: receptionCookie }));
        expect(res.status).toBe(200);
        expect((await res.json()).total).toBe(3);
        expect((await listPaymentsRoute(request("/api/payments", { cookie: assistantCookie }))).status).toBe(403);
        expect((await listPaymentsRoute(request("/api/payments", { cookie: doctorCookie }))).status).toBe(403);
      });

      it("voids a payment for the owner only, with a reason; it leaves the totals", async () => {
        expect((await post(voidRoute, `/api/payments/${payment}/void`, payment, { reason: "Entered twice" }, receptionCookie)).res.status).toBe(403);
        expect((await post(voidRoute, `/api/payments/${payment}/void`, payment, { reason: "" })).res.status).toBe(422);
        expect((await post(voidRoute, `/api/payments/${payment}/void`, payment, { reason: "Not ours" }, ownerBCookie)).res.status).toBe(404);
        const voided = await post(voidRoute, `/api/payments/${payment}/void`, payment, { reason: "Entered twice" });
        expect(voided.res.status).toBe(200);
        expect(voided.json.payment.deletedAt).toBeTruthy();
        const res = await getProcedureRoute(request(`/api/procedures/${planned}`, { cookie: ownerCookie }), params(planned));
        expect((await res.json()).procedure.balance).toBe(53_000);
        const list = await (await listPaymentsRoute(request(`/api/payments?patientId=${patientA}`, { cookie: ownerCookie }))).json();
        expect(list.payments.map((p: { id: string }) => p.id)).not.toContain(payment);
        const withVoided = await (await listPaymentsRoute(request(`/api/payments?patientId=${patientA}&includeVoided=1`, { cookie: ownerCookie }))).json();
        expect(withVoided.payments.map((p: { id: string }) => p.id)).toContain(payment);
        expect(await db.auditLog.count({ where: { tenantId: a, action: "payment.void", entityId: payment } })).toBe(1);
        expect((await post(voidRoute, `/api/payments/${payment}/void`, payment, { reason: "again" })).res.status).toBe(404);
      });
    });
  });

  describe("summary and export", () => {
    it("gives the owner the period's figures and refuses reception (finance:read)", async () => {
      expect((await summaryRoute(request("/api/finance/summary?period=28d", { cookie: receptionCookie }))).status).toBe(403);
      expect((await summaryRoute(request("/api/finance/summary?period=28d", { cookie: doctorCookie }))).status).toBe(403);
      expect((await summaryRoute(request("/api/finance/summary?period=28d"))).status).toBe(401);
      const res = await summaryRoute(request("/api/finance/summary?period=90d", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      const { summary, period } = await res.json();
      expect(period.preset).toBe("90d");
      // Charged so far: the transplant (62,000 − 5,000; performed in three days, outside the period) and Ali's acne (2,000, today).
      expect(summary.revenue.current).toBe(2_000);
      expect(summary.procedures.current).toBe(1);
      // Collected: deposit 5,000 + refund −1,000 (the 30,000 payment was voided).
      expect(summary.collected.current).toBe(4_000);
      expect(summary.deposits.current).toBe(5_000);
      expect(summary.refunds.current).toBe(1_000);
      // Owed on the patients' accounts: the transplant less the deposit, plus the refund; Ali's acne.
      expect(summary.outstanding).toMatchObject({ amount: 55_000, patients: 2, previousAmount: 0 });
      expect(summary.outstandingPatients[0]).toMatchObject({ patientId: patientA, amount: 53_000, dueOnInvoices: 0, notInvoiced: 57_000, oldestDueAt: null });
      expect(summary.byDoctor).toEqual([expect.objectContaining({ id: owner.id, amount: 2_000, count: 1 })]);
      const other = await (await summaryRoute(request("/api/finance/summary?period=90d", { cookie: ownerBCookie }))).json();
      expect(other.summary.revenue.current).toBe(0);
      expect(other.summary.outstanding.amount).toBe(0);
    });

    it("compares what is owed now with what was owed when the comparison period ended", async () => {
      // Tenant B: a procedure signed (and charged) 120 days ago for 10,000; 4,000 paid 100 days ago and 3,000 ten days ago.
      const signedAt = new Date(Date.now() - 120 * DAY);
      const old = await db.procedure.create({ data: { tenantId: b, patientId: patientB, treatmentId: acneB, performedAt: signedAt, signedAt, status: "SIGNED", price: 10_000 } });
      await db.charge.create({ data: { tenantId: b, patientId: patientB, procedureId: old.id, amount: 10_000, description: "Acne treatment", chargedAt: signedAt } });
      await db.payment.createMany({
        data: [
          { tenantId: b, patientId: patientB, procedureId: old.id, kind: "PAYMENT", amount: 4_000, paidAt: new Date(Date.now() - 100 * DAY) },
          { tenantId: b, patientId: patientB, procedureId: old.id, kind: "PAYMENT", amount: 3_000, paidAt: new Date(Date.now() - 10 * DAY) },
        ],
      });
      const { summary } = await (await summaryRoute(request("/api/finance/summary?period=90d", { cookie: ownerBCookie }))).json();
      expect(summary.outstanding).toMatchObject({ amount: 3_000, previousAmount: 6_000, patients: 1 });
      expect(summary.revenue.current).toBe(0);
      expect(summary.collected).toEqual({ current: 3_000, previous: 4_000 });
    });

    it("exports the period's payments and procedures as CSV (owner only, 422 for an unknown kind)", async () => {
      const res = await exportRoute(request("/api/finance/export?kind=payments&period=90d", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="payments-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
      // A UTF-8 byte-order mark so Excel reads Arabic names (Response.text() drops it, so read the bytes).
      const bytes = new Uint8Array(await res.clone().arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const lines = (await res.text()).trim().split("\r\n");
      expect(lines[0]).toBe("Date,Time,Patient,Kind,Method,Amount (EGP),Reference,Procedure,Note,Import batch");
      expect(lines.some((l) => l.includes("Refund") && l.includes("-1000"))).toBe(true);
      expect(lines.some((l) => l.includes("30000"))).toBe(false);
      const procedures = await (await exportRoute(request("/api/finance/export?kind=procedures&period=90d", { cookie: ownerCookie }))).text();
      expect(procedures).toContain("Acne treatment");
      expect((await exportRoute(request("/api/finance/export?kind=everything", { cookie: ownerCookie }))).status).toBe(422);
      expect((await exportRoute(request("/api/finance/export?kind=payments", { cookie: receptionCookie }))).status).toBe(403);
    });
  });

  describe("POS CSV import", () => {
    const csv = [
      "date,phone,amount,kind,method,reference,name",
      "2026-10-20 14:10,0100 111 2233,2500,payment,visa,POS-9001,Mona",
      "21/10/2026,٠١٠٠٤٤٤٥٥٦٦,600,consultation,cash,RCPT-77,Ali",
      "2026-10-21,01009999999,900,payment,cash,RCPT-78,Stranger",
      "someday,01001112233,abc,,,RCPT-79,",
      "2026-10-22,01001112233,300,refund,cash,POS-9001,Mona",
    ].join("\n");

    it("previews: matches patients by phone (Arabic digits read), lists the problems, writes nothing", async () => {
      const before = await db.payment.count({ where: { tenantId: a } });
      const res = await importRoute(request("/api/payments/import", { method: "POST", cookie: receptionCookie, body: { csv } }));
      expect(res.status).toBe(200);
      const preview = await res.json();
      expect(preview.summary).toEqual({ total: 5, ready: 2, unmatched: 1, invalid: 2, amount: 3_100 });
      const [mona, ali, stranger, broken, dup] = preview.rows;
      expect(mona).toMatchObject({ line: 2, ok: true, kind: "PAYMENT", method: "CARD", patient: { id: patientA } });
      expect(ali).toMatchObject({ ok: true, kind: "CONSULTATION_FEE", method: "CASH", amount: 600, patient: { id: patientA2 } });
      expect(stranger).toMatchObject({ ok: false, patient: null, problems: ["No patient with this phone number"] });
      expect(broken.problems).toEqual(expect.arrayContaining(["Unreadable date", "Unreadable or zero amount"]));
      expect(dup.problems).toContain("Duplicate reference inside the file");
      // Tenant B's patient with the same phone is never matched.
      expect(preview.rows.every((r: { patient: { id: string } | null }) => r.patient?.id !== patientB)).toBe(true);
      expect(await db.payment.count({ where: { tenantId: a } })).toBe(before);
    });

    it("confirms the ready rows as payments under one batch, audited; the same file then shows them as existing", async () => {
      const preview = await (await importRoute(request("/api/payments/import", { method: "POST", cookie: receptionCookie, body: { csv } }))).json();
      const rows = preview.rows
        .filter((r: { ok: boolean }) => r.ok)
        .map((r: { patient: { id: string }; paidAt: string; amount: number; kind: string; method: string; reference: string }) => ({ patientId: r.patient.id, paidAt: r.paidAt, amount: r.amount, kind: r.kind, method: r.method, reference: r.reference }));
      const res = await confirmRoute(request("/api/payments/import/confirm", { method: "POST", cookie: receptionCookie, body: { rows } }));
      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.created).toBe(2);
      const imported = await db.payment.findMany({ where: { tenantId: a, importBatchId: json.importBatchId } });
      expect(imported.map((p) => p.amount).sort((x, y) => x - y)).toEqual([600, 2_500]);
      expect(await db.auditLog.count({ where: { tenantId: a, action: "payment.import", entityId: json.importBatchId } })).toBe(1);
      const again = await (await importRoute(request("/api/payments/import", { method: "POST", cookie: receptionCookie, body: { csv } }))).json();
      expect(again.rows[0].problems).toContain("A payment with this reference already exists");
      expect(again.summary.ready).toBe(0);
      // Sending the same confirmation twice (a retry, a double tap) adds nothing.
      const retry = await confirmRoute(request("/api/payments/import/confirm", { method: "POST", cookie: receptionCookie, body: { rows } }));
      expect(retry.status).toBe(201);
      expect(await retry.json()).toMatchObject({ created: 0, skipped: 2 });
      expect(await db.payment.count({ where: { tenantId: a, reference: { in: ["POS-9001", "RCPT-77"] } } })).toBe(2);
    });

    it("refuses an empty file (422), read-only roles (403) and another clinic's patient (404)", async () => {
      expect((await importRoute(request("/api/payments/import", { method: "POST", cookie: receptionCookie, body: { csv: "" } }))).status).toBe(422);
      expect((await importRoute(request("/api/payments/import", { method: "POST", cookie: assistantCookie, body: { csv } }))).status).toBe(403);
      expect((await confirmRoute(request("/api/payments/import/confirm", { method: "POST", cookie: receptionCookie, body: { rows: [] } }))).status).toBe(422);
      const before = await db.payment.count({ where: { tenantId: b } });
      const foreign = await confirmRoute(
        request("/api/payments/import/confirm", { method: "POST", cookie: receptionCookie, body: { rows: [{ patientId: patientB, paidAt: new Date().toISOString(), amount: 100, kind: "PAYMENT" }] } }),
      );
      expect(foreign.status).toBe(404);
      expect(await db.payment.count({ where: { tenantId: b } })).toBe(before);
    });
  });
});

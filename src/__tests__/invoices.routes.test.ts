/**
 * Invoices and receipts over the real route handlers and the test database:
 * drafts from unbilled charges (no number, can change or be discarded);
 * issuing takes the branch's next number with no gaps (concurrent issues
 * included) and puts the patient's credit towards it; money in goes to the
 * oldest open invoice, a deposit for a procedure only to the invoice that
 * bills it; an issued invoice never changes and is never deleted; the owner
 * cancels with a numbered credit note that gives back what was paid; every
 * payment has its receipt number; refunds are the owner's, with the reason,
 * within the credit; the patient's copy is a link that needs no sign-in.
 * RBAC and tenant isolation on every endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { deriveBranchCode, formatDocumentNumber } from "@/modules/finance/documents";
import { invoiceByToken } from "@/modules/finance/invoices";
import { GET as listRoute, POST as createRoute } from "@/app/api/invoices/route";
import { GET as billableRoute } from "@/app/api/invoices/billable/route";
import { DELETE as discardRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/invoices/[id]/route";
import { POST as issueRoute } from "@/app/api/invoices/[id]/issue/route";
import { POST as cancelRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as sendRoute } from "@/app/api/invoices/[id]/send/route";
import { POST as paymentRoute } from "@/app/api/payments/route";
import { POST as voidRoute } from "@/app/api/payments/[id]/void/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DAY = 86_400_000;

describe("document numbers (pure)", () => {
  it("names a branch from its place, and numbers with six digits", () => {
    expect(deriveBranchCode("Aura Clinic — Zamalek")).toBe("ZAM");
    expect(deriveBranchCode("Aura Clinic — New Cairo")).toBe("NEW");
    expect(deriveBranchCode("Downtown")).toBe("DOW");
    expect(deriveBranchCode("— ١٢٣")).toBe("BR");
    expect(formatDocumentNumber("ZAM", "INVOICE", 42)).toBe("ZAM-INV-000042");
    expect(formatDocumentNumber("ZAM", "CREDIT_NOTE", 3)).toBe("ZAM-CN-000003");
    expect(formatDocumentNumber("ZAM", "RECEIPT", 1)).toBe("ZAM-RC-000001");
    expect(formatDocumentNumber("ZAM", "REFUND", 7)).toBe("ZAM-RF-000007");
  });
});

describe.skipIf(!dbTestsEnabled)("invoice routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let branch1: string;
  let branch2: string;
  let acne: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let patientB: string;
  let n = 0;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const call = (route: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, method: string, body: unknown, cookie: string) =>
    route(request(path, { method, cookie, body }), params(id)).then(json);
  const draft = (body: Record<string, unknown>, cookie = receptionCookie) => createRoute(request("/api/invoices", { method: "POST", cookie, body })).then(json);
  const issue = (id: string, cookie = receptionCookie) => call(issueRoute, `/api/invoices/${id}/issue`, id, "POST", undefined, cookie);
  const cancel = (id: string, reason: string, cookie = ownerCookie) => call(cancelRoute, `/api/invoices/${id}/cancel`, id, "POST", { reason }, cookie);
  const read = (id: string, cookie = receptionCookie) => getRoute(request(`/api/invoices/${id}`, { cookie }), params(id)).then(json);
  const pay = (body: Record<string, unknown>, cookie = receptionCookie) => paymentRoute(request("/api/payments", { method: "POST", cookie, body })).then(json);
  const patient = async (name: string, language = "en") => (await db.patient.create({ data: { tenantId: a, fullName: name, phone: `+2010099${String(++n).padStart(5, "0")}`, language } })).id;
  const charge = async (patientId: string, amount: number, extra: Record<string, unknown> = {}) =>
    (await db.charge.create({ data: { tenantId: a, patientId, amount, description: `Treatment ${++n}`, chargedAt: new Date(Date.now() - DAY), clinicId: branch1, ...extra } })).id;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `inv-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `inv-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    branch1 = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    await db.clinic.update({ where: { id: branch1 }, data: { name: "Test Clinic — Zamalek" } });
    branch2 = (await db.clinic.create({ data: { tenantId: a, name: "Test Clinic — Dokki" } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await ensureDefaultTreatments(a);
    acne = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "acne" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b, fullName: "Patient Of B", phone: "+201009999999" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("drafts", () => {
    let p: string;
    let c1: string;
    let c2: string;
    let id: string;

    beforeAll(async () => {
      p = await patient("Salma Arabic", "ar");
      c1 = await charge(p, 2_000);
      c2 = await charge(p, 1_500);
    });

    it("bills the patient's unbilled charges in a draft with no number, in their language", async () => {
      const billable = await billableRoute(request(`/api/invoices/billable?patientId=${p}`, { cookie: receptionCookie })).then(json);
      expect(billable.json).toMatchObject({ total: 3_500 });
      const made = await draft({ patientId: p });
      expect(made.res.status).toBe(201);
      expect(made.json.invoice).toMatchObject({ status: "DRAFT", number: null, total: 3_500, language: "ar", due: 0 });
      expect(made.json.invoice.lines.map((l: { chargeId: string }) => l.chargeId)).toEqual([c1, c2]);
      id = made.json.invoice.id;
      // Its charges are taken: nothing left to bill.
      expect((await draft({ patientId: p })).json.error).toBe("nothing_to_bill");
      expect((await draft({ patientId: p, chargeIds: [c1] })).json.error).toBe("not_billable");
    });

    it("changes while a draft: language, lines; never empty", async () => {
      const changed = await call(patchRoute, `/api/invoices/${id}`, id, "PATCH", { language: "en", removeChargeIds: [c2] }, receptionCookie);
      expect(changed.res.status).toBe(200);
      expect(changed.json.invoice).toMatchObject({ language: "en", total: 2_000 });
      expect((await call(patchRoute, `/api/invoices/${id}`, id, "PATCH", { removeChargeIds: [c1] }, receptionCookie)).json.error).toBe("nothing_to_bill");
    });

    it("is discarded without a trace of a number; its charges are billable again", async () => {
      const gone = await call(discardRoute, `/api/invoices/${id}`, id, "DELETE", undefined, receptionCookie);
      expect(gone.res.status).toBe(200);
      expect(await db.invoice.count({ where: { id } })).toBe(0);
      const billable = await billableRoute(request(`/api/invoices/billable?patientId=${p}`, { cookie: receptionCookie })).then(json);
      expect(billable.json.charges.map((c: { id: string }) => c.id)).toEqual([c1, c2]);
    });

    it("keeps one branch per invoice", async () => {
      const other = await charge(p, 900, { clinicId: branch2 });
      const mixed = await draft({ patientId: p, chargeIds: [c1, other] });
      expect(mixed.res.status).toBe(422);
      // By default it takes the branch of the oldest charge, and only that branch's.
      const auto = await draft({ patientId: p });
      expect(auto.json.invoice.lines).toHaveLength(2);
      await call(discardRoute, `/api/invoices/${auto.json.invoice.id}`, auto.json.invoice.id, "DELETE", undefined, receptionCookie);
    });
  });

  describe("numbers, credit and payments", () => {
    let mona: string;
    let first: string;
    let second: string;

    it("issues with the branch's next number and puts the patient's credit towards it", async () => {
      mona = await patient("Mona Paid");
      const prepaid = await pay({ patientId: mona, kind: "PAYMENT", method: "CASH", amount: 1_000 });
      expect(prepaid.res.status).toBe(201);
      expect(prepaid.json.payment.receiptNumber).toBe("ZAM-RC-000001");
      await charge(mona, 3_500);
      const made = await draft({ patientId: mona });
      const issued = await issue(made.json.invoice.id);
      expect(issued.res.status).toBe(200);
      expect(issued.json.invoice).toMatchObject({ number: "ZAM-INV-000001", status: "PART_PAID", total: 3_500, paid: 1_000, due: 2_500 });
      expect(issued.json.invoice.payments).toEqual([expect.objectContaining({ receiptNumber: "ZAM-RC-000001", amount: 1_000 })]);
      first = made.json.invoice.id;
      expect((await issue(first)).res.status).toBe(409);
    });

    it("never spends a number on a discarded draft, and numbers each branch on its own", async () => {
      const p = await patient("Karim Branches");
      await charge(p, 800);
      const thrown = await draft({ patientId: p });
      await call(discardRoute, `/api/invoices/${thrown.json.invoice.id}`, thrown.json.invoice.id, "DELETE", undefined, receptionCookie);
      const kept = await draft({ patientId: p });
      expect((await issue(kept.json.invoice.id)).json.invoice.number).toBe("ZAM-INV-000002");
      await charge(p, 600, { clinicId: branch2 });
      const dokki = await draft({ patientId: p });
      expect((await issue(dokki.json.invoice.id)).json.invoice.number).toBe("DOK-INV-000001");
      second = kept.json.invoice.id;
    });

    it("gives invoices issued at the same moment consecutive numbers, none twice and none skipped", async () => {
      const drafts: string[] = [];
      for (let i = 0; i < 6; i++) {
        const p = await patient(`Rush ${i}`);
        await charge(p, 500 + i);
        drafts.push((await draft({ patientId: p })).json.invoice.id);
      }
      const numbers = (await Promise.all(drafts.map((id) => issue(id)))).map((r) => r.json.invoice.number as string).sort();
      expect(numbers).toEqual(["ZAM-INV-000003", "ZAM-INV-000004", "ZAM-INV-000005", "ZAM-INV-000006", "ZAM-INV-000007", "ZAM-INV-000008"]);
    });

    it("puts money in towards the oldest open invoice first", async () => {
      await charge(mona, 1_200);
      const later = await draft({ patientId: mona });
      await issue(later.json.invoice.id);
      const paid = await pay({ patientId: mona, kind: "PAYMENT", method: "INSTAPAY", amount: 3_000 });
      expect(paid.json.payment.receiptNumber).toBe("ZAM-RC-000002");
      expect((await read(first)).json.invoice).toMatchObject({ status: "PAID", paid: 3_500, due: 0 });
      expect((await read(later.json.invoice.id)).json.invoice).toMatchObject({ status: "PART_PAID", paid: 500, due: 700 });
    });

    it("holds a deposit for a procedure until the invoice that bills it", async () => {
      const p = await patient("Deposit Holder");
      const procedure = await db.procedure.create({ data: { tenantId: a, patientId: p, treatmentId: acne, performedAt: new Date(), price: 2_000 } });
      await pay({ patientId: p, kind: "DEPOSIT", method: "CASH", amount: 700, procedureId: procedure.id });
      await charge(p, 1_000);
      const unrelated = await issue((await draft({ patientId: p })).json.invoice.id);
      expect(unrelated.json.invoice).toMatchObject({ status: "ISSUED", paid: 0 });
      await charge(p, 2_000, { procedureId: procedure.id });
      const billed = await issue((await draft({ patientId: p })).json.invoice.id);
      expect(billed.json.invoice).toMatchObject({ status: "PART_PAID", paid: 700, due: 1_300 });
    });

    it("never changes or deletes an issued invoice", async () => {
      expect((await call(patchRoute, `/api/invoices/${first}`, first, "PATCH", { language: "ar" }, receptionCookie)).res.status).toBe(409);
      expect((await call(discardRoute, `/api/invoices/${first}`, first, "DELETE", undefined, receptionCookie)).res.status).toBe(409);
      await expect(db.invoice.delete({ where: { id: first } })).rejects.toThrow();
      await expect(db.invoice.update({ where: { id: first }, data: { total: 1 } })).rejects.toThrow();
      await expect(db.invoice.update({ where: { id: first }, data: { number: "ZAM-INV-999999" } })).rejects.toThrow();
      const line = await db.invoiceLine.findFirstOrThrow({ where: { invoiceId: first } });
      await expect(db.invoiceLine.update({ where: { id: line.id }, data: { amount: 1 } })).rejects.toThrow();
      await expect(db.invoiceLine.delete({ where: { id: line.id } })).rejects.toThrow();
      expect((await read(first)).json.invoice).toMatchObject({ number: "ZAM-INV-000001", total: 3_500 });
    });

    it("lets the owner cancel with a numbered credit note; what was paid goes back as credit and on to open invoices", async () => {
      expect((await cancel(second, "Billed twice", receptionCookie)).res.status).toBe(403);
      expect((await cancel(second, "")).res.status).toBe(422);
      const before = await read(first);
      const cancelled = await cancel(first, "Billed the wrong treatment");
      expect(cancelled.res.status).toBe(200);
      expect(cancelled.json.invoice).toMatchObject({ status: "CANCELLED", paid: 0, due: 0, creditNote: { number: "ZAM-CN-000001", amount: before.json.invoice.total, reason: "Billed the wrong treatment" } });
      // Mona's money went on to her other open invoice.
      const others = await listRoute(request(`/api/invoices?patientId=${mona}&status=PAID`, { cookie: receptionCookie })).then(json);
      expect(others.json.invoices.length).toBe(1);
      // Its charges can be billed again; the credit note never changes.
      const billable = await billableRoute(request(`/api/invoices/billable?patientId=${mona}`, { cookie: receptionCookie })).then(json);
      expect(billable.json.total).toBe(3_500);
      const note = await db.creditNote.findFirstOrThrow({ where: { invoiceId: first } });
      await expect(db.creditNote.update({ where: { id: note.id }, data: { amount: 1 } })).rejects.toThrow();
      expect((await cancel(first, "Again")).res.status).toBe(409);
    });

    it("gives every payment a receipt number, never reused, and refunds their own", async () => {
      const p = await patient("Receipt Run");
      const one = await pay({ patientId: p, kind: "PAYMENT", method: "CARD", amount: 400 });
      const two = await pay({ patientId: p, kind: "CONSULTATION_FEE", method: "CASH", amount: 600 });
      const [s1, s2] = [one.json.payment.receiptNumber, two.json.payment.receiptNumber].map((x: string) => Number(x.slice(-6)));
      expect(s2).toBe(s1! + 1);
      const voided = await call(voidRoute, `/api/payments/${one.json.payment.id}/void`, one.json.payment.id, "POST", { reason: "Wrong patient" }, ownerCookie);
      expect(voided.res.status).toBe(200);
      const three = await pay({ patientId: p, kind: "PAYMENT", method: "CHEQUE", amount: 300 });
      expect(Number(three.json.payment.receiptNumber.slice(-6))).toBe(s2! + 1);
      const refund = await pay({ patientId: p, kind: "REFUND", method: "CASH", amount: 300, note: "Treatment not done" }, ownerCookie);
      expect(refund.json.payment.receiptNumber).toMatch(/^ZAM-RF-\d{6}$/);
      // Within the credit only: the 300 left is gone now.
      const tooMuch = await pay({ patientId: p, kind: "REFUND", method: "CASH", amount: 1, note: "Again" }, ownerCookie);
      expect(tooMuch.res.status).toBe(409);
      expect(tooMuch.json.error).toBe("not_enough_credit");
    });

    it("takes back what a voided payment paid on invoices", async () => {
      const p = await patient("Void Back");
      await charge(p, 1_000);
      const inv = (await issue((await draft({ patientId: p })).json.invoice.id)).json.invoice.id as string;
      const money = await pay({ patientId: p, kind: "PAYMENT", method: "CASH", amount: 1_000 });
      expect((await read(inv)).json.invoice.status).toBe("PAID");
      await call(voidRoute, `/api/payments/${money.json.payment.id}/void`, money.json.payment.id, "POST", { reason: "Counterfeit note" }, ownerCookie);
      expect((await read(inv)).json.invoice).toMatchObject({ status: "ISSUED", paid: 0, due: 1_000 });
    });
  });

  describe("the patient's copy", () => {
    let id: string;

    it("sends a link on WhatsApp that opens without signing in; the latest link is the one that works", async () => {
      const p = await patient("Nour Sent", "ar");
      await charge(p, 2_500);
      const made = await draft({ patientId: p });
      expect((await call(sendRoute, `/api/invoices/${made.json.invoice.id}/send`, made.json.invoice.id, "POST", undefined, receptionCookie)).res.status).toBe(409);
      id = (await issue(made.json.invoice.id)).json.invoice.id;
      const sent = await call(sendRoute, `/api/invoices/${id}/send`, id, "POST", undefined, receptionCookie);
      expect(sent.res.status).toBe(200);
      expect(sent.json.link).toMatch(/\/i\/[A-Za-z0-9_-]{40,}$/);
      const message = await db.message.findFirstOrThrow({ where: { tenantId: a, templateKey: "invoice:send" }, orderBy: { createdAt: "desc" } });
      expect(message.body).toContain("فاتورتك رقم ZAM-INV-");
      expect(message.body).toContain(sent.json.link);
      const token = sent.json.link.split("/i/")[1] as string;
      expect((await invoiceByToken(token))?.id).toBe(id);
      const again = await call(sendRoute, `/api/invoices/${id}/send`, id, "POST", undefined, receptionCookie);
      expect(await invoiceByToken(token)).toBeNull();
      expect((await invoiceByToken(again.json.link.split("/i/")[1]))?.number).toMatch(/^ZAM-INV-/);
      expect(await invoiceByToken("not-a-token")).toBeNull();
    });
  });

  describe("who may", () => {
    it("is the front desk's and the owner's, inside their own clinic", async () => {
      expect((await listRoute(request("/api/invoices", { cookie: doctorCookie }))).status).toBe(403);
      expect((await listRoute(request("/api/invoices", { cookie: assistantCookie }))).status).toBe(403);
      expect((await listRoute(request("/api/invoices", { cookie: ownerCookie }))).status).toBe(200);
      const p = await patient("Isolated");
      await charge(p, 700);
      const mine = (await draft({ patientId: p })).json.invoice.id as string;
      expect((await read(mine, ownerBCookie)).res.status).toBe(404);
      expect((await issue(mine, ownerBCookie)).res.status).toBe(404);
      expect((await draft({ patientId: patientB })).res.status).toBe(404);
      expect((await draft({ patientId: p }, doctorCookie)).res.status).toBe(403);
    });
  });
});

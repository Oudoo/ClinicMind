/**
 * The patient's account over the real route handlers and the test database:
 * the ledger's running balance (charges, payments, a consultation fee on both
 * sides, refunds, reversals), a period with the balance brought forward and
 * carried, where the account stands (due on invoices + not invoiced − credit
 * = the balance); family accounts (a head pays for members after their own
 * money, never the other way; one level, refused by the service and by the
 * database; leaving keeps what was paid); the balance at check-in and on the
 * next-appointment card; a signed procedure on an issued invoice is not
 * reversed until the invoice is cancelled. RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, fromDateKey } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { balanceWords, describeEntry, entryText } from "@/modules/finance/ledger-copy";
import { GET as ledgerRoute } from "@/app/api/patients/[id]/ledger/route";
import { GET as householdGetRoute, PUT as householdRoute } from "@/app/api/patients/[id]/household/route";
import { GET as invoicesRoute, POST as draftRoute } from "@/app/api/invoices/route";
import { POST as issueRoute } from "@/app/api/invoices/[id]/issue/route";
import { POST as cancelInvoiceRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as paymentRoute } from "@/app/api/payments/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { GET as nextRoute } from "@/app/api/appointments/next/route";
import { POST as createProcedureRoute } from "@/app/api/procedures/route";
import { POST as signRoute } from "@/app/api/procedures/[id]/sign/route";
import { POST as cancelProcedureRoute } from "@/app/api/procedures/[id]/cancel/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DAY = 86_400_000;

interface Entry {
  kind: string;
  debit: number;
  credit: number;
  balance: number;
  reference: string | null;
  counterpart: string | null;
  invoiceNumber: string | null;
  patientId: string;
}

describe("ledger wording (pure)", () => {
  it("says each line in English and Arabic, keeping names and numbers in one piece", () => {
    expect(entryText({ kind: "PAYMENT", description: null, method: "INSTAPAY", towards: "Laser hair removal", note: null, counterpart: null, invoiceNumber: null })).toBe("Payment · InstaPay · towards Laser hair removal");
    expect(entryText({ kind: "REVERSAL", description: "Reversed: Acne peel", method: null, towards: null, note: null, counterpart: null, invoiceNumber: null }, "ar")).toBe("إلغاء: Acne peel");
    const paidBy = describeEntry({ kind: "PAID_BY", description: null, method: null, towards: null, note: null, counterpart: "Hany Nabil", invoiceNumber: "ZAM-INV-000042" }, "ar");
    expect(paidBy.find((p) => p.t === "ZAM-INV-000042")?.iso).toBe("ltr");
    expect(paidBy.find((p) => p.t === "Hany Nabil")?.iso).toBe("auto");
    expect(balanceWords(2_400)).toBe("Owes 2,400 EGP");
    expect(balanceWords(-600)).toBe("In credit 600 EGP");
    expect(balanceWords(0)).toBe("Settled");
    expect(balanceWords(2_400, "ar")).toBe("مستحق 2,400 جنيه");
  });
});

describe.skipIf(!dbTestsEnabled)("patient ledger and family account routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let timezone: string;
  let branch: string;
  let acne: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let doctorId: string;
  let patientB: string;
  let n = 0;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const at = (offsetDays: number, hour = 10) => new Date(fromDateKey(dateKeyInTz(addDays(new Date(), offsetDays, timezone), timezone), timezone)!.getTime() + hour * 3_600_000);
  const dayKey = (offsetDays: number) => dateKeyInTz(addDays(new Date(), offsetDays, timezone), timezone);
  const patient = async (name: string) => (await db.patient.create({ data: { tenantId: a, fullName: name, phone: `+2010088${String(++n).padStart(5, "0")}` } })).id;
  const charge = async (patientId: string, amount: number, when: Date, extra: Record<string, unknown> = {}) =>
    (await db.charge.create({ data: { tenantId: a, patientId, amount, description: `Treatment ${++n}`, chargedAt: when, clinicId: branch, ...extra } })).id;
  const pay = (body: Record<string, unknown>, cookie = receptionCookie) => paymentRoute(request("/api/payments", { method: "POST", cookie, body })).then(json);
  const ledger = (id: string, qs = "", cookie = receptionCookie) => ledgerRoute(request(`/api/patients/${id}/ledger${qs}`, { cookie }), params(id)).then(json);
  const setHead = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => householdRoute(request(`/api/patients/${id}/household`, { method: "PUT", cookie, body }), params(id)).then(json);
  const household = (id: string, cookie = receptionCookie) => householdGetRoute(request(`/api/patients/${id}/household`, { cookie }), params(id)).then(json);
  const invoice = async (patientId: string) => {
    const draft = await draftRoute(request("/api/invoices", { method: "POST", cookie: receptionCookie, body: { patientId } })).then(json);
    expect(draft.res.status).toBe(201);
    const id = draft.json.invoice.id as string;
    const issued = await issueRoute(request(`/api/invoices/${id}/issue`, { method: "POST", cookie: receptionCookie }), params(id)).then(json);
    expect(issued.res.status).toBe(200);
    return issued.json.invoice as { id: string; number: string; status: string; total: number; paid: number; due: number };
  };
  const invoiceStatus = async (id: string) => (await db.invoice.findUniqueOrThrow({ where: { id } })).status;
  /** The account's identity: the balance is what is due on invoices plus what is not invoiced, less the credit. */
  const consistent = (position: { balance: number; dueOnInvoices: number; notInvoiced: number; credit: number }) => position.balance === position.dueOnInvoices + position.notInvoiced - position.credit;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `ldg-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `ldg-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    timezone = await getTenantTimezone(a);
    branch = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    await db.clinic.update({ where: { id: branch }, data: { name: "Test Clinic — Zamalek" } });
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorId = doctor.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await ensureDefaultTreatments(a);
    acne = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "acne" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b, fullName: "Patient Of B", phone: "+201008888888" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("the running balance", () => {
    let p: string;
    let reversed: string;

    beforeAll(async () => {
      p = await patient("Ledger Patient");
      await charge(p, 3_000, at(-10));
      reversed = await charge(p, 2_000, at(-5));
      expect((await pay({ patientId: p, kind: "CONSULTATION_FEE", method: "CASH", amount: 500, paidAt: at(-4).toISOString() })).res.status).toBe(201);
      expect((await pay({ patientId: p, kind: "PAYMENT", method: "CARD", amount: 4_000, paidAt: at(-3).toISOString() })).res.status).toBe(201);
      expect((await pay({ patientId: p, kind: "REFUND", method: "CASH", amount: 300, paidAt: at(-2, 9).toISOString(), note: "Overpaid at the desk" }, ownerCookie)).res.status).toBe(201);
      await charge(p, -2_000, at(-2, 11), { reversalOfId: reversed, description: "Reversed: Treatment two" });
    });

    it("puts every charge and every payment in date order with the balance after each", async () => {
      const { res, json: view } = await ledger(p);
      expect(res.status).toBe(200);
      const rows = view.entries as Entry[];
      expect(rows.map((e) => [e.kind, e.debit, e.credit, e.balance])).toEqual([
        ["CHARGE", 3_000, 0, 3_000],
        ["CHARGE", 2_000, 0, 5_000],
        // A consultation fee is charged and paid at once.
        ["CONSULTATION_FEE", 500, 500, 5_000],
        ["PAYMENT", 0, 4_000, 1_000],
        // Money going back out adds to what is owed.
        ["REFUND", 300, 0, 1_300],
        ["REVERSAL", 0, 2_000, -700],
      ]);
      expect(rows[3]!.reference).toMatch(/^ZAM-RC-\d{6}$/);
      expect(rows[4]!.reference).toMatch(/^ZAM-RF-\d{6}$/);
      expect(view).toMatchObject({ scope: "patient", opening: 0, closing: -700, totals: { debit: 5_800, credit: 6_500 } });
      // Where it stands: nothing invoiced, 3,000 not invoiced, 3,700 credit.
      expect(view.position).toMatchObject({ balance: -700, dueOnInvoices: 0, notInvoiced: 3_000, credit: 3_700, billed: 3_500, received: 4_200 });
      expect(consistent(view.position)).toBe(true);
    });

    it("gives any period with the balance brought forward and carried, the last day included", async () => {
      const { res, json: view } = await ledger(p, `?from=${dayKey(-5)}&to=${dayKey(-3)}`);
      expect(res.status).toBe(200);
      expect(view.opening).toBe(3_000);
      expect((view.entries as Entry[]).map((e) => e.kind)).toEqual(["CHARGE", "CONSULTATION_FEE", "PAYMENT"]);
      expect(view.closing).toBe(1_000);
      expect(view.position.balance).toBe(-700);
    });

    it("refuses dates that are not real or run backwards", async () => {
      expect((await ledger(p, "?from=2026-02-30")).res.status).toBe(422);
      expect((await ledger(p, `?from=${dayKey(-1)}&to=${dayKey(-3)}`)).res.status).toBe(422);
    });

    it("leaves voided payments out", async () => {
      const q = await patient("Voided Payment");
      const made = await pay({ patientId: q, kind: "PAYMENT", method: "CASH", amount: 900, paidAt: at(-1).toISOString() });
      await db.payment.update({ where: { id: made.json.payment.id }, data: { deletedAt: new Date() } });
      const { json: view } = await ledger(q);
      expect(view.entries).toEqual([]);
      expect(view.position.balance).toBe(0);
    });
  });

  describe("with invoices", () => {
    it("names the invoice that bills a charge, and the balance is what is still due on it", async () => {
      const q = await patient("Invoiced Patient");
      await charge(q, 5_000, at(-6));
      await charge(q, 1_000, at(-6, 12));
      const inv = await invoice(q);
      expect((await pay({ patientId: q, kind: "PAYMENT", method: "INSTAPAY", amount: 2_500, paidAt: at(-1).toISOString() })).res.status).toBe(201);
      expect(await invoiceStatus(inv.id)).toBe("PART_PAID");
      const { json: view } = await ledger(q);
      expect((view.entries as Entry[]).filter((e) => e.kind === "CHARGE").map((e) => e.reference)).toEqual([inv.number, inv.number]);
      expect(view.position).toMatchObject({ balance: 3_500, dueOnInvoices: 3_500, notInvoiced: 0, credit: 0 });
      expect(view.position.openInvoices).toEqual([expect.objectContaining({ id: inv.id, total: 6_000, paid: 2_500, due: 3_500 })]);
      expect(consistent(view.position)).toBe(true);
    });
  });

  describe("family accounts", () => {
    let head: string;
    let m1: string;
    let m2: string;
    let outsider: string;
    let m1Invoice: { id: string; number: string };
    let m2Invoice: { id: string; number: string };

    beforeAll(async () => {
      head = await patient("Hany Head");
      m1 = await patient("Nesma Member");
      m2 = await patient("Sherif Member");
      outsider = await patient("Someone Else");
    });

    it("puts members in the head's family, and says who pays for whom", async () => {
      const joined = await setHead(m1, { headId: head, relation: "CHILD" });
      expect(joined.res.status).toBe(200);
      expect(joined.json).toMatchObject({ role: "member", head: { id: head }, members: [{ id: m1, relation: "CHILD" }] });
      expect((await setHead(m2, { headId: head })).json).toMatchObject({ role: "member" });
      expect(await db.patient.findUniqueOrThrow({ where: { id: m2 } })).toMatchObject({ householdHeadId: head, householdRelation: "OTHER" });
      const view = await household(head);
      expect(view.json).toMatchObject({ role: "head", head: { id: head }, familyBalance: 0 });
      expect(view.json.members.map((m: { id: string }) => m.id)).toEqual([m1, m2]);
      const audited = await db.auditLog.findFirst({ where: { tenantId: a, action: "patient.household", entityId: m1 } });
      expect(audited?.after).toMatchObject({ headId: head, relation: "CHILD" });
    });

    it("keeps families one level deep: in the service and in the database", async () => {
      // The head does not join another family, and a member heads no one.
      expect((await setHead(head, { headId: outsider })).json.error).toBe("pays_for_others");
      const chain = await setHead(outsider, { headId: m1 });
      expect(chain.res.status).toBe(409);
      expect(chain.json).toMatchObject({ error: "head_is_member" });
      expect(chain.json.message).toContain("Hany Head");
      expect((await setHead(head, { headId: head })).res.status).toBe(422);
      expect((await setHead(outsider, { headId: "no-such-patient" })).res.status).toBe(404);
      // Written straight to the database, a chain is refused too.
      await expect(db.patient.update({ where: { id: outsider }, data: { householdHeadId: m1 } })).rejects.toThrow(/no head of their own/);
      await expect(db.patient.update({ where: { id: head }, data: { householdHeadId: outsider } })).rejects.toThrow(/does not join another family/);
      await expect(db.patient.update({ where: { id: outsider }, data: { householdHeadId: patientB } })).rejects.toThrow(/same clinic/);
    });

    it("pays a member's invoice with the head's money once their own is used, oldest first", async () => {
      await charge(m1, 2_000, at(-8));
      m1Invoice = await invoice(m1);
      // The head pays: it goes on to the member's open invoice.
      const paid = await pay({ patientId: head, kind: "PAYMENT", method: "BANK_TRANSFER", amount: 5_000, paidAt: at(-7).toISOString() });
      expect(paid.res.status).toBe(201);
      expect(await invoiceStatus(m1Invoice.id)).toBe("PAID");
      // The other member pays 1,000 of their own; their invoice takes it first, then 500 of the head's.
      expect((await pay({ patientId: m2, kind: "PAYMENT", method: "CASH", amount: 1_000, paidAt: at(-6).toISOString() })).res.status).toBe(201);
      await charge(m2, 1_500, at(-5));
      m2Invoice = await invoice(m2);
      expect(await invoiceStatus(m2Invoice.id)).toBe("PAID");
      const onM2 = await db.paymentAllocation.findMany({ where: { invoiceId: m2Invoice.id }, select: { amount: true, payment: { select: { patientId: true } } } });
      expect(onM2.map((x) => [x.payment.patientId, x.amount]).sort()).toEqual([[head, 500], [m2, 1_000]].sort());

      const member = await ledger(m1);
      expect((member.json.entries as Entry[]).map((e) => [e.kind, e.debit, e.credit, e.balance, e.counterpart, e.invoiceNumber])).toEqual([
        ["CHARGE", 2_000, 0, 2_000, null, m1Invoice.number],
        ["PAID_BY", 0, 2_000, 0, "Hany Head", m1Invoice.number],
      ]);
      const payer = await ledger(head);
      expect((payer.json.entries as Entry[]).map((e) => [e.kind, e.debit, e.credit, e.counterpart])).toEqual([
        ["PAYMENT", 0, 5_000, null],
        ["PAID_FOR", 2_000, 0, "Nesma Member"],
        ["PAID_FOR", 500, 0, "Sherif Member"],
      ]);
      expect(payer.json.position).toMatchObject({ balance: -2_500, credit: 2_500 });
      for (const id of [head, m1, m2]) expect(consistent((await ledger(id)).json.position)).toBe(true);
    });

    it("shows the family's statement once: the money as it came in, against every member's charges", async () => {
      const { json: view } = await ledger(m2, "?family=1");
      expect(view.scope).toBe("family");
      expect(view.family.members.map((m: { id: string; head: boolean }) => [m.id, m.head])).toEqual([
        [head, true],
        [m1, false],
        [m2, false],
      ]);
      const rows = view.entries as Entry[];
      expect(rows.some((e) => e.kind === "PAID_BY" || e.kind === "PAID_FOR")).toBe(false);
      expect(rows.map((e) => [e.kind, e.patientId, e.debit, e.credit])).toEqual([
        ["CHARGE", m1, 2_000, 0],
        ["PAYMENT", head, 0, 5_000],
        ["PAYMENT", m2, 0, 1_000],
        ["CHARGE", m2, 1_500, 0],
      ]);
      expect(view.closing).toBe(-2_500);
      expect(view.position.balance).toBe(-2_500);
      expect((await household(m1)).json.familyBalance).toBe(-2_500);
    });

    it("never pays the head's invoices with a member's money", async () => {
      expect((await pay({ patientId: m2, kind: "PAYMENT", method: "CASH", amount: 300, paidAt: at(-1).toISOString() })).res.status).toBe(201);
      await charge(head, 2_800, at(-1, 12));
      const own = await invoice(head);
      expect(await invoiceStatus(own.id)).toBe("PART_PAID");
      const onIt = await db.paymentAllocation.findMany({ where: { invoiceId: own.id }, select: { amount: true, payment: { select: { patientId: true } } } });
      expect(onIt.map((x) => x.payment.patientId)).toEqual([head]);
      expect(onIt.reduce((s, x) => s + x.amount, 0)).toBe(2_500);
      expect((await ledger(m2)).json.position.credit).toBe(300);
    });

    it("lets the head match a payment to a member's invoice by hand, but not a member to the head's", async () => {
      await charge(m1, 700, at(0, 9));
      const next = await invoice(m1);
      const listed = await invoicesRoute(request(`/api/invoices?patientId=${head}&payable=1&status=OPEN`, { cookie: receptionCookie })).then(json);
      expect(listed.json.invoices.map((i: { id: string }) => i.id)).toContain(next.id);
      const matched = await pay({ patientId: head, kind: "PAYMENT", method: "CASH", amount: 700, invoiceId: next.id });
      expect(matched.res.status).toBe(201);
      expect(await invoiceStatus(next.id)).toBe("PAID");
      const ownInvoice = await db.invoice.findFirstOrThrow({ where: { tenantId: a, patientId: head, status: "PART_PAID" } });
      expect((await pay({ patientId: m2, kind: "PAYMENT", method: "CASH", amount: 100, invoiceId: ownInvoice.id })).res.status).toBe(404);
    });

    it("keeps what the head paid when a member leaves; from then on each pays for themselves", async () => {
      const left = await setHead(m1, { headId: null });
      expect(left.json).toMatchObject({ role: "none", head: null, members: [] });
      expect(await db.patient.findUniqueOrThrow({ where: { id: m1 } })).toMatchObject({ householdHeadId: null, householdRelation: null });
      expect(await invoiceStatus(m1Invoice.id)).toBe("PAID");
      expect((await ledger(m1)).json.entries.some((e: Entry) => e.kind === "PAID_BY")).toBe(true);
      for (const id of [head, m1, m2]) expect(consistent((await ledger(id)).json.position)).toBe(true);
      expect((await household(head)).json.members.map((m: { id: string }) => m.id)).toEqual([m2]);
    });

    it("re-allocates the head's money when a member's invoice is cancelled", async () => {
      const before = (await ledger(head)).json.position.credit as number;
      const cancelled = await cancelInvoiceRoute(request(`/api/invoices/${m2Invoice.id}/cancel`, { method: "POST", cookie: ownerCookie, body: { reason: "Billed twice by mistake" } }), params(m2Invoice.id)).then(json);
      expect(cancelled.res.status).toBe(200);
      // The head's 500 went back to the head (and on to their own part-paid invoice); the member's 1,000 back to them.
      const ownInvoice = await db.invoice.findFirstOrThrow({ where: { tenantId: a, patientId: head, total: 2_800 } });
      expect(await invoiceStatus(ownInvoice.id)).toBe("PAID");
      expect((await ledger(head)).json.position.credit).toBe(before + 500 - 300);
      expect((await ledger(m2)).json.position.credit).toBe(1_300);
      for (const id of [head, m1, m2]) expect(consistent((await ledger(id)).json.position)).toBe(true);
    });

    it("is for the front desk and the owner; another clinic's patients stay out of reach", async () => {
      expect((await ledger(head, "", ownerCookie)).res.status).toBe(200);
      expect((await ledger(head, "", doctorCookie)).res.status).toBe(403);
      expect((await ledger(head, "", assistantCookie)).res.status).toBe(403);
      expect((await household(head, doctorCookie)).res.status).toBe(403);
      expect((await setHead(outsider, { headId: head }, doctorCookie)).res.status).toBe(403);
      expect((await ledger(head, "", ownerBCookie)).res.status).toBe(404);
      expect((await household(head, ownerBCookie)).res.status).toBe(404);
      expect((await setHead(head, { headId: null }, ownerBCookie)).res.status).toBe(404);
      expect((await setHead(outsider, { headId: patientB })).res.status).toBe(404);
    });
  });

  describe("the balance at check-in", () => {
    it("tells the desk what the patient owes when they check in, and shows it on the next-appointment card", async () => {
      const p = await patient("Arriving Patient");
      await charge(p, 2_400, at(-3));
      const visit = await db.appointment.create({ data: { tenantId: a, patientId: p, status: "CONFIRMED", startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 60_000) }, select: { id: true } });
      const card = await nextRoute(request(`/api/appointments/next?patientId=${p}`, { cookie: receptionCookie })).then(json);
      expect(card.json.appointment).toMatchObject({ id: visit.id, patientBalance: 2_400 });
      const doctorCard = await nextRoute(request(`/api/appointments/next?patientId=${p}`, { cookie: doctorCookie })).then(json);
      expect(doctorCard.json.appointment.patientBalance).toBeUndefined();
      const checkIn = await transitionRoute(request(`/api/appointments/${visit.id}/transition`, { method: "POST", cookie: receptionCookie, body: { status: "CHECKED_IN" } }), params(visit.id)).then(json);
      expect(checkIn.res.status).toBe(200);
      expect(checkIn.json).toMatchObject({ appointment: { status: "CHECKED_IN" }, balance: 2_400 });
      // A doctor moving the visit on is not told about money.
      const started = await transitionRoute(request(`/api/appointments/${visit.id}/transition`, { method: "POST", cookie: doctorCookie, body: { status: "IN_PROGRESS" } }), params(visit.id)).then(json);
      expect(started.res.status).toBe(200);
      expect(started.json.balance).toBeUndefined();
    });
  });

  describe("cancelling invoiced work", () => {
    const signed = async (patientId: string, price: number) => {
      const made = await createProcedureRoute(request("/api/procedures", { method: "POST", cookie: ownerCookie, body: { patientId, treatmentId: acne, doctorId, performedAt: at(-2).toISOString(), price } })).then(json);
      expect(made.res.status).toBe(201);
      const id = made.json.procedure.id as string;
      expect((await signRoute(request(`/api/procedures/${id}/sign`, { method: "POST", cookie: doctorCookie }), params(id)).then(json)).res.status).toBe(200);
      return id;
    };
    const cancelProcedure = (id: string) => cancelProcedureRoute(request(`/api/procedures/${id}/cancel`, { method: "POST", cookie: doctorCookie, body: { reason: "Recorded on the wrong patient" } }), params(id)).then(json);

    it("asks for the invoice to be cancelled first, then reverses the charge", async () => {
      const p = await patient("Invoiced Work");
      const procedure = await signed(p, 1_800);
      const inv = await invoice(p);
      const refused = await cancelProcedure(procedure);
      expect(refused.res.status).toBe(409);
      expect(refused.json).toMatchObject({ error: "invoiced", invoiceId: inv.id });
      expect(refused.json.message).toContain(inv.number);
      expect(await db.charge.count({ where: { procedureId: procedure, amount: { lt: 0 } } })).toBe(0);
      const cancelled = await cancelInvoiceRoute(request(`/api/invoices/${inv.id}/cancel`, { method: "POST", cookie: ownerCookie, body: { reason: "Work recorded on the wrong patient" } }), params(inv.id)).then(json);
      expect(cancelled.res.status).toBe(200);
      expect((await cancelProcedure(procedure)).res.status).toBe(200);
      const { json: view } = await ledger(p);
      expect((view.entries as Entry[]).map((e) => [e.kind, e.balance])).toEqual([
        ["CHARGE", 1_800],
        ["REVERSAL", 0],
      ]);
      expect(view.position).toMatchObject({ balance: 0, dueOnInvoices: 0, notInvoiced: 0, credit: 0 });
    });

    it("takes the work off a draft (and the draft away when nothing is left on it)", async () => {
      const p = await patient("Drafted Work");
      const procedure = await signed(p, 900);
      const draft = await draftRoute(request("/api/invoices", { method: "POST", cookie: receptionCookie, body: { patientId: p } })).then(json);
      expect(draft.res.status).toBe(201);
      expect((await cancelProcedure(procedure)).res.status).toBe(200);
      expect(await db.invoice.count({ where: { id: draft.json.invoice.id } })).toBe(0);
    });
  });
});

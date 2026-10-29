/**
 * Discounts and write-offs over the real route handlers and the test
 * database: every discount has a reason from the fixed list; each role gives
 * up to its limit (reception and nurses 10%, doctors 20% unless the owner
 * sets otherwise; the owner has none), on a procedure and on a line of a
 * draft invoice (all of a line's discounts together); a discount is a line
 * of its own, stays with its charge and is reversed with its procedure; the
 * owner writes off what is left on an issued invoice, with a reason, which
 * settles it without money, is never edited, and goes only with the invoice.
 * RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { DEFAULT_DISCOUNT_LIMITS, discountLimitFor, withinDiscountLimit } from "@/modules/finance/constants";
import { entryText } from "@/modules/finance/ledger-copy";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { GET as settingsGetRoute, PUT as settingsRoute } from "@/app/api/finance/settings/route";
import { POST as createProcedureRoute } from "@/app/api/procedures/route";
import { PATCH as updateProcedureRoute } from "@/app/api/procedures/[id]/route";
import { POST as signRoute } from "@/app/api/procedures/[id]/sign/route";
import { POST as cancelProcedureRoute } from "@/app/api/procedures/[id]/cancel/route";
import { POST as draftRoute } from "@/app/api/invoices/route";
import { PATCH as patchInvoiceRoute } from "@/app/api/invoices/[id]/route";
import { POST as issueRoute } from "@/app/api/invoices/[id]/issue/route";
import { POST as cancelInvoiceRoute } from "@/app/api/invoices/[id]/cancel/route";
import { POST as discountRoute } from "@/app/api/invoices/[id]/discount/route";
import { POST as writeOffRoute } from "@/app/api/invoices/[id]/write-off/route";
import { POST as paymentRoute } from "@/app/api/payments/route";
import { GET as ledgerRoute } from "@/app/api/patients/[id]/ledger/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, openShifts, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DAY = 86_400_000;

describe("discount limits (pure)", () => {
  it("gives each role its share and the owner no limit", () => {
    expect(discountLimitFor("RECEPTIONIST", DEFAULT_DISCOUNT_LIMITS)).toBe(10);
    expect(discountLimitFor("NURSE", DEFAULT_DISCOUNT_LIMITS)).toBe(10);
    expect(discountLimitFor("DOCTOR", DEFAULT_DISCOUNT_LIMITS)).toBe(20);
    expect(discountLimitFor("CLINIC_OWNER", DEFAULT_DISCOUNT_LIMITS)).toBe(100);
    expect(discountLimitFor("ASSISTANT", DEFAULT_DISCOUNT_LIMITS)).toBe(0);
    expect(withinDiscountLimit(2_000, 200, 10)).toBe(true);
    expect(withinDiscountLimit(2_000, 201, 10)).toBe(false);
    expect(withinDiscountLimit(2_000, 0, 0)).toBe(true);
  });

  it("says discounts and write-offs in both languages", () => {
    const base = { description: null, method: null, towards: null, note: null, counterpart: null, invoiceNumber: null };
    expect(entryText({ ...base, kind: "DISCOUNT", description: "Discount (returning patient): Acne peel", reason: "LOYALTY" })).toBe("Discount (returning patient): Acne peel");
    expect(entryText({ ...base, kind: "DISCOUNT", description: "Discount (returning patient): Acne peel", reason: "LOYALTY" }, "ar")).toBe("خصم (عميل دائم): Acne peel");
    expect(entryText({ ...base, kind: "WRITE_OFF", reason: "SMALL_BALANCE", invoiceNumber: "ZAM-INV-000007" })).toBe("Written off (too small to chase): invoice ZAM-INV-000007");
    expect(entryText({ ...base, kind: "WRITE_OFF", reason: "BAD_DEBT", invoiceNumber: "ZAM-INV-000007" }, "ar")).toBe("شطب (دين معدوم): الفاتورة ZAM-INV-000007");
  });
});

describe.skipIf(!dbTestsEnabled)("discount and write-off routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let branch: string;
  let acne: string;
  let doctorId: string;
  let receptionId: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let nurseCookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let n = 0;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const patient = async (name: string) => (await db.patient.create({ data: { tenantId: a, fullName: name, phone: `+2010077${String(++n).padStart(5, "0")}` } })).id;
  const charge = async (patientId: string, amount: number) =>
    (await db.charge.create({ data: { tenantId: a, patientId, amount, description: `Treatment ${++n}`, chargedAt: new Date(Date.now() - 2 * DAY), clinicId: branch } })).id;
  const procedure = (body: Record<string, unknown>, cookie: string) =>
    createProcedureRoute(request("/api/procedures", { method: "POST", cookie, body: { treatmentId: acne, doctorId, performedAt: new Date(Date.now() - DAY).toISOString(), price: 2_000, ...body } })).then(json);
  const draft = async (patientId: string) => {
    const made = await draftRoute(request("/api/invoices", { method: "POST", cookie: receptionCookie, body: { patientId } })).then(json);
    expect(made.res.status).toBe(201);
    return made.json.invoice as { id: string; total: number; lines: { chargeId: string; amount: number; description: string }[] };
  };
  const discount = (invoiceId: string, body: Record<string, unknown>, cookie = receptionCookie) => discountRoute(request(`/api/invoices/${invoiceId}/discount`, { method: "POST", cookie, body }), params(invoiceId)).then(json);
  const issue = (invoiceId: string) => issueRoute(request(`/api/invoices/${invoiceId}/issue`, { method: "POST", cookie: receptionCookie }), params(invoiceId)).then(json);
  const writeOff = (invoiceId: string, body: Record<string, unknown>, cookie = ownerCookie) => writeOffRoute(request(`/api/invoices/${invoiceId}/write-off`, { method: "POST", cookie, body }), params(invoiceId)).then(json);
  const pay = (body: Record<string, unknown>) => paymentRoute(request("/api/payments", { method: "POST", cookie: receptionCookie, body })).then(json);
  const ledger = (patientId: string) => ledgerRoute(request(`/api/patients/${patientId}/ledger`, { cookie: receptionCookie }), params(patientId)).then(json);
  const status = async (invoiceId: string) => (await db.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status;
  const consistent = (p: { balance: number; dueOnInvoices: number; notInvoiced: number; credit: number }) => p.balance === p.dueOnInvoices + p.notInvoiced - p.credit;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `dsc-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `dsc-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    branch = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    await db.clinic.update({ where: { id: branch }, data: { name: "Test Clinic — Zamalek" } });
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorId = doctor.id;
    receptionId = reception.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await openShifts(a, [owner.id, reception.id, nurse.id], branch);
    await ensureDefaultTreatments(a);
    acne = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "acne" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("a discount on a procedure", () => {
    let p: string;
    beforeAll(async () => {
      p = await patient("Discount Patient");
    });

    it("needs a reason from the list, and the words for another reason", async () => {
      const bare = await procedure({ patientId: p, discount: 200 }, receptionCookie);
      expect(bare.res.status).toBe(422);
      expect(JSON.stringify(bare.json)).toContain("discountReason");
      const other = await procedure({ patientId: p, discount: 200, discountReason: "OTHER" }, receptionCookie);
      expect(other.res.status).toBe(422);
      expect(JSON.stringify(other.json)).toContain("discountNote");
      expect((await procedure({ patientId: p, discount: 200, discountReason: "FREE_STUFF" }, receptionCookie)).res.status).toBe(422);
    });

    it("lets each role give up to its limit, and the owner more", async () => {
      const ok = await procedure({ patientId: p, discount: 200, discountReason: "LOYALTY" }, receptionCookie);
      expect(ok.res.status).toBe(201);
      expect(await db.procedure.findUniqueOrThrow({ where: { id: ok.json.procedure.id } })).toMatchObject({ discount: 200, discountReason: "LOYALTY", discountById: receptionId });
      const over = await procedure({ patientId: p, discount: 300, discountReason: "LOYALTY" }, receptionCookie);
      expect(over.res.status).toBe(403);
      expect(over.json).toMatchObject({ error: "discount_limit", limit: 10, asked: 15 });
      expect(over.json.message).toContain("10%");
      expect((await procedure({ patientId: p, discount: 300, discountReason: "GOODWILL" }, nurseCookie)).res.status).toBe(403);
      expect((await procedure({ patientId: p, discount: 400, discountReason: "DOCTOR" }, doctorCookie)).res.status).toBe(201);
      expect((await procedure({ patientId: p, discount: 500, discountReason: "DOCTOR" }, doctorCookie)).res.status).toBe(403);
      const owner = await procedure({ patientId: p, discount: 1_000, discountReason: "STAFF" }, ownerCookie);
      expect(owner.res.status).toBe(201);
    });

    it("holds an edit to the limit too, but not a change that leaves the discount alone", async () => {
      const owners = await procedure({ patientId: p, discount: 1_000, discountReason: "STAFF" }, ownerCookie);
      const id = owners.json.procedure.id as string;
      const patch = (body: Record<string, unknown>) => updateProcedureRoute(request(`/api/procedures/${id}`, { method: "PATCH", cookie: receptionCookie, body }), params(id)).then(json);
      expect((await patch({ notes: "Patient asked for the morning" })).res.status).toBe(200);
      expect((await patch({ discount: 1_100 })).res.status).toBe(403);
      expect((await patch({ discount: 100 })).res.status).toBe(200);
      expect(await db.procedure.findUniqueOrThrow({ where: { id } })).toMatchObject({ discount: 100, discountReason: "STAFF", discountById: receptionId });
      const cleared = await patch({ discount: 0 });
      expect(cleared.res.status).toBe(200);
      expect(await db.procedure.findUniqueOrThrow({ where: { id } })).toMatchObject({ discount: 0, discountReason: null, discountById: null });
    });

    it("lets the owner set the limits, which everyone can read", async () => {
      const set = (body: unknown, cookie = ownerCookie) => settingsRoute(request("/api/finance/settings", { method: "PUT", cookie, body })).then(json);
      expect((await set({ discountLimits: { RECEPTIONIST: 20, NURSE: 10, DOCTOR: 20 } }, receptionCookie)).res.status).toBe(403);
      expect((await set({ discountLimits: { RECEPTIONIST: 120, NURSE: 10, DOCTOR: 20 } })).res.status).toBe(422);
      const saved = await set({ discountLimits: { RECEPTIONIST: 20, NURSE: 10, DOCTOR: 25 } });
      expect(saved.res.status).toBe(200);
      expect(saved.json.discountLimits).toEqual({ RECEPTIONIST: 20, NURSE: 10, DOCTOR: 25 });
      const read = await settingsGetRoute(request("/api/finance/settings", { cookie: receptionCookie })).then(json);
      expect(read.json).toMatchObject({ myDiscountLimit: 20 });
      expect((await procedure({ patientId: p, discount: 300, discountReason: "LOYALTY" }, receptionCookie)).res.status).toBe(201);
      const audited = await db.auditLog.findFirst({ where: { tenantId: a, action: "finance.discount_limits" } });
      expect(audited?.after).toMatchObject({ RECEPTIONIST: 20 });
      // Back to the defaults for the tests below.
      expect((await set({ discountLimits: DEFAULT_DISCOUNT_LIMITS })).res.status).toBe(200);
    });
  });

  describe("a discount on a line of a draft invoice", () => {
    let p: string;
    let work: string;
    let other: string;
    let invoiceId: string;

    beforeAll(async () => {
      p = await patient("Line Discount Patient");
      work = await charge(p, 2_000);
      other = await charge(p, 1_000);
      invoiceId = (await draft(p)).id;
    });

    it("puts the discount on the draft as its own line, with its reason", async () => {
      const given = await discount(invoiceId, { chargeId: work, amount: 200, reason: "LOYALTY" });
      expect(given.res.status).toBe(200);
      expect(given.json.invoice.total).toBe(2_800);
      const line = given.json.invoice.lines.find((l: { amount: number }) => l.amount === -200);
      expect(line.description).toMatch(/^Discount \(returning patient\): Treatment/);
      expect(given.json.invoice.discountOf[line.chargeId]).toBe(work);
      expect(await db.charge.findUniqueOrThrow({ where: { id: line.chargeId } })).toMatchObject({ amount: -200, discountOfId: work, reason: "LOYALTY", patientId: p });
    });

    it("holds all of a line's discounts together to the role's limit, and the line", async () => {
      const more = await discount(invoiceId, { chargeId: work, amount: 100, reason: "GOODWILL" });
      expect(more.res.status).toBe(403);
      expect(more.json).toMatchObject({ error: "discount_limit", limit: 10, asked: 15 });
      expect((await discount(invoiceId, { chargeId: work, amount: 300, reason: "GOODWILL" }, ownerCookie)).res.status).toBe(200);
      expect((await discount(invoiceId, { chargeId: work, amount: 1_600, reason: "GOODWILL" }, ownerCookie)).res.status).toBe(422);
      const discountLine = (await db.charge.findFirstOrThrow({ where: { discountOfId: work } })).id;
      expect((await discount(invoiceId, { chargeId: discountLine, amount: 10, reason: "GOODWILL" }, ownerCookie)).json.error).toBe("not_discountable");
      expect((await discount(invoiceId, { chargeId: work, amount: 50, reason: "OTHER" }, ownerCookie)).res.status).toBe(422);
    });

    it("keeps a discount with its charge on the draft", async () => {
      const discountLines = await db.charge.findMany({ where: { discountOfId: work }, select: { id: true } });
      const patch = (body: Record<string, unknown>) => patchInvoiceRoute(request(`/api/invoices/${invoiceId}`, { method: "PATCH", cookie: receptionCookie, body }), params(invoiceId)).then(json);
      expect((await patch({ removeChargeIds: [discountLines[0]!.id] })).json.error).toBe("discount_stays");
      const off = await patch({ removeChargeIds: [work] });
      expect(off.res.status).toBe(200);
      expect(off.json.invoice.lines.map((l: { chargeId: string }) => l.chargeId)).toEqual([other]);
      // A new draft of the charge brings its discounts along.
      const again = await draftRoute(request("/api/invoices", { method: "POST", cookie: receptionCookie, body: { patientId: p, chargeIds: [work] } })).then(json);
      expect(again.res.status).toBe(201);
      expect(again.json.invoice.total).toBe(1_500);
      expect((await issue(again.json.invoice.id)).json.invoice).toMatchObject({ status: "ISSUED", total: 1_500 });
      expect((await discount(again.json.invoice.id, { chargeId: work, amount: 10, reason: "GOODWILL" }, ownerCookie)).json.error).toBe("invalid_state");
      const { json: view } = await ledger(p);
      expect(view.entries.filter((e: { kind: string }) => e.kind === "DISCOUNT").map((e: { credit: number }) => e.credit).sort()).toEqual([200, 300]);
      expect(consistent(view.position)).toBe(true);
    });

    it("reverses a procedure's discounts with it", async () => {
      const q = await patient("Reversed Discount");
      const made = await procedure({ patientId: q, price: 3_000 }, ownerCookie);
      const id = made.json.procedure.id as string;
      expect((await signRoute(request(`/api/procedures/${id}/sign`, { method: "POST", cookie: doctorCookie }), params(id)).then(json)).res.status).toBe(200);
      const d = await draft(q);
      expect((await discount(d.id, { chargeId: d.lines[0]!.chargeId, amount: 300, reason: "PROMOTION" })).res.status).toBe(200);
      const cancelled = await cancelProcedureRoute(request(`/api/procedures/${id}/cancel`, { method: "POST", cookie: doctorCookie, body: { reason: "Recorded twice" } }), params(id)).then(json);
      expect(cancelled.res.status).toBe(200);
      expect(await db.invoice.count({ where: { id: d.id } })).toBe(0);
      const { json: view } = await ledger(q);
      expect(view.position).toMatchObject({ balance: 0, notInvoiced: 0 });
      expect((await db.charge.aggregate({ where: { procedureId: id }, _sum: { amount: true } }))._sum.amount).toBe(0);
    });

    it("is for whoever takes payments; another clinic's drafts stay out of reach", async () => {
      const q = await patient("Rights Patient");
      const c = await charge(q, 1_000);
      const d = await draft(q);
      expect((await discount(d.id, { chargeId: c, amount: 50, reason: "LOYALTY" }, doctorCookie)).res.status).toBe(403);
      expect((await discount(d.id, { chargeId: c, amount: 50, reason: "LOYALTY" }, assistantCookie)).res.status).toBe(403);
      expect((await discount(d.id, { chargeId: c, amount: 50, reason: "LOYALTY" }, nurseCookie)).res.status).toBe(200);
      expect((await discount(d.id, { chargeId: c, amount: 50, reason: "LOYALTY" }, ownerBCookie)).res.status).toBe(404);
    });
  });

  describe("write-offs", () => {
    it("settles what is left without money: the owner's, with the reason", async () => {
      const p = await patient("Small Balance");
      await charge(p, 1_000);
      const inv = await draft(p);
      expect((await issue(inv.id)).res.status).toBe(200);
      expect((await pay({ patientId: p, kind: "PAYMENT", method: "CASH", amount: 700 })).res.status).toBe(201);
      expect(await status(inv.id)).toBe("PART_PAID");
      expect((await writeOff(inv.id, { reason: "SMALL_BALANCE" }, receptionCookie)).res.status).toBe(403);
      expect((await writeOff(inv.id, { amount: 400, reason: "SMALL_BALANCE" })).res.status).toBe(422);
      expect((await writeOff(inv.id, { reason: "OTHER" })).res.status).toBe(422);
      const done = await writeOff(inv.id, { reason: "SMALL_BALANCE", note: "No answer to three reminders" });
      expect(done.res.status).toBe(200);
      expect(done.json.invoice).toMatchObject({ status: "PAID", paid: 700, writtenOff: 300, due: 0, writeOffs: [{ amount: 300, reason: "SMALL_BALANCE" }] });
      expect((await writeOff(inv.id, { reason: "SMALL_BALANCE" })).json.error).toBe("invalid_state");
      const { json: view } = await ledger(p);
      expect(view.entries.at(-1)).toMatchObject({ kind: "WRITE_OFF", credit: 300, balance: 0, reference: expect.stringMatching(/-INV-\d{6}$/) });
      expect(view.position).toMatchObject({ balance: 0, dueOnInvoices: 0, credit: 0 });
      expect(consistent(view.position)).toBe(true);
      const audited = await db.auditLog.findFirst({ where: { tenantId: a, action: "invoice.write_off", entityId: inv.id } });
      expect(audited?.after).toMatchObject({ amount: 300, reason: "SMALL_BALANCE" });
    });

    it("can write off part, and money pays the rest", async () => {
      const p = await patient("Part Written Off");
      await charge(p, 1_000);
      const inv = await draft(p);
      await issue(inv.id);
      const part = await writeOff(inv.id, { amount: 400, reason: "BAD_DEBT" });
      expect(part.json.invoice).toMatchObject({ status: "PART_PAID", writtenOff: 400, due: 600 });
      expect((await pay({ patientId: p, kind: "PAYMENT", method: "CASH", amount: 1_000 })).res.status).toBe(201);
      expect(await status(inv.id)).toBe("PAID");
      // Only what was left went to the invoice; the rest is the patient's credit.
      const { json: view } = await ledger(p);
      expect(view.position).toMatchObject({ balance: -400, credit: 400 });
      expect(consistent(view.position)).toBe(true);
    });

    it("goes with the invoice when it is cancelled, and is never edited", async () => {
      const p = await patient("Cancelled Write-off");
      await charge(p, 800);
      const inv = await draft(p);
      await issue(inv.id);
      await writeOff(inv.id, { reason: "DISPUTE" });
      const row = await db.writeOff.findFirstOrThrow({ where: { invoiceId: inv.id } });
      await expect(db.writeOff.update({ where: { id: row.id }, data: { amount: 100 } })).rejects.toThrow(/never edited/);
      await expect(db.writeOff.delete({ where: { id: row.id } })).rejects.toThrow(/never deleted/);
      const cancelled = await cancelInvoiceRoute(request(`/api/invoices/${inv.id}/cancel`, { method: "POST", cookie: ownerCookie, body: { reason: "Billed the wrong branch" } }), params(inv.id)).then(json);
      expect(cancelled.res.status).toBe(200);
      expect((await db.writeOff.findUniqueOrThrow({ where: { id: row.id } })).voidedAt).not.toBeNull();
      // The charge is owed again in full, and nothing became refundable credit.
      const { json: view } = await ledger(p);
      expect(view.entries.some((e: { kind: string }) => e.kind === "WRITE_OFF")).toBe(false);
      expect(view.position).toMatchObject({ balance: 800, notInvoiced: 800, credit: 0 });
    });

    it("keeps another clinic's invoices out of reach", async () => {
      const p = await patient("Isolated Invoice");
      await charge(p, 500);
      const inv = await draft(p);
      await issue(inv.id);
      expect((await writeOff(inv.id, { reason: "BAD_DEBT" }, ownerBCookie)).res.status).toBe(404);
    });
  });
});

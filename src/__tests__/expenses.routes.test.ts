/**
 * Expenses and suppliers (Phase 5) over the real route handlers and the test
 * database: suppliers with what is owed to each; a bill to pay by a day or
 * money spent at once, paid in one payment or several, never past its amount
 * (the database refuses it too); cash at the desk out of the cashier's drawer,
 * which then expects less, and stays once the day is signed off; voiding by
 * the owner (an expense's payments with it), never deleting; receipts' photos
 * and PDFs typed by their bytes; recurring expenses making one bill a month;
 * salaries the owner's alone; RBAC and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { dateKeyInTz, fromDateKey } from "@/lib/time";
import { parseFilePayload, sniffFileType, UploadError } from "@/lib/uploads";
import { monthOfKey, shiftMonth } from "@/modules/finance/doctor-pay-calc";
import { makeRecurringBills, recurringMonths } from "@/modules/finance/expenses";
import { GET as expensesGet, POST as expensesPost } from "@/app/api/expenses/route";
import { GET as expenseGet, PATCH as expensePatch } from "@/app/api/expenses/[id]/route";
import { POST as expenseVoid } from "@/app/api/expenses/[id]/void/route";
import { POST as expensePay } from "@/app/api/expenses/[id]/payments/route";
import { POST as expenseFilesPost } from "@/app/api/expenses/[id]/files/route";
import { POST as paymentVoid } from "@/app/api/expense-payments/[id]/void/route";
import { DELETE as fileDelete, GET as fileGet } from "@/app/api/expense-files/[id]/route";
import { GET as suppliersGet, POST as suppliersPost } from "@/app/api/suppliers/route";
import { GET as supplierGet, PATCH as supplierPatch } from "@/app/api/suppliers/[id]/route";
import { GET as recurringGet, POST as recurringPost } from "@/app/api/recurring-expenses/route";
import { PATCH as recurringPatch } from "@/app/api/recurring-expenses/[id]/route";
import { POST as recurringStop } from "@/app/api/recurring-expenses/[id]/stop/route";
import { GET as myShiftRoute, POST as openShiftRoute } from "@/app/api/cash/shift/route";
import { POST as closeShiftRoute } from "@/app/api/cash/shifts/[id]/close/route";
import { POST as signOffRoute } from "@/app/api/cash/day/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const today = () => dateKeyInTz(new Date(), TZ);
const dayKey = (offset: number) => dateKeyInTz(new Date(Date.now() + offset * 86_400_000), TZ);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

describe("expenses (pure)", () => {
  it("makes a recurring expense's months from its first, every so many months", () => {
    expect(recurringMonths({ startMonth: "2026-08", everyMonths: 1 }, "2026-10")).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(recurringMonths({ startMonth: "2025-11", everyMonths: 3 }, "2026-10")).toEqual(["2025-11", "2026-02", "2026-05", "2026-08"]);
    expect(recurringMonths({ startMonth: "2026-11", everyMonths: 1 }, "2026-10")).toEqual([]);
  });

  it("types a file by its bytes, never by what the client says", () => {
    expect(sniffFileType(Buffer.from(PNG, "base64"))).toBe("image/png");
    expect(sniffFileType(Buffer.from(PDF, "base64"))).toBe("application/pdf");
    expect(sniffFileType(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    const limits = { max: 2, maxBytes: 1_000 };
    expect(parseFilePayload([{ name: "r/../x.png", type: "image/jpeg", data: `data:image/png;base64,${PNG}` }], limits)[0]).toMatchObject({ mimeType: "image/png", name: "r .. x.png" });
    expect(() => parseFilePayload([{ type: "image/png", data: Buffer.from("<html>").toString("base64") }], limits)).toThrow(UploadError);
    expect(() => parseFilePayload([{ data: Buffer.alloc(2_000, 1).toString("base64") }], limits)).toThrow(/1 MB or smaller|0 MB or smaller/);
    expect(() => parseFilePayload([{ data: PNG }, { data: PNG }, { data: PNG }], limits)).toThrow(/At most 2/);
  });
});

describe.skipIf(!dbTestsEnabled)("expense routes", () => {
  const created: string[] = [];
  let a: string;
  let branch: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let doctorCookie: string;
  let ownerBCookie: string;

  type Json = Record<string, any>;
  const json = async (res: Response) => ({ res, json: (await res.json()) as Json });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const create = (body: Record<string, unknown>, cookie = receptionCookie) => expensesPost(request("/api/expenses", { method: "POST", cookie, body })).then(json);
  const list = (query: Record<string, string> = {}, cookie = ownerCookie) => expensesGet(request(`/api/expenses?${new URLSearchParams(query).toString()}`, { cookie })).then(json);
  const get = (id: string, cookie = ownerCookie) => expenseGet(request(`/api/expenses/${id}`, { cookie }), params(id)).then(json);
  const edit = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => expensePatch(request(`/api/expenses/${id}`, { method: "PATCH", cookie, body }), params(id)).then(json);
  const pay = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => expensePay(request(`/api/expenses/${id}/payments`, { method: "POST", cookie, body }), params(id)).then(json);
  const voidIt = (id: string, cookie = ownerCookie) => expenseVoid(request(`/api/expenses/${id}/void`, { method: "POST", cookie, body: { reason: "Entered twice" } }), params(id)).then(json);
  const voidPayment = (id: string, cookie = ownerCookie) => paymentVoid(request(`/api/expense-payments/${id}/void`, { method: "POST", cookie, body: { reason: "Wrong bill" } }), params(id)).then(json);
  const attach = (id: string, files: unknown[], cookie = receptionCookie) => expenseFilesPost(request(`/api/expenses/${id}/files`, { method: "POST", cookie, body: { files } }), params(id)).then(json);
  const shift = (cookie = receptionCookie) => myShiftRoute(request("/api/cash/shift", { cookie })).then(json);
  const cashExpected = async (cookie = receptionCookie) => (await shift(cookie)).json.shift.methods.find((m: Json) => m.method === "CASH").expected as number;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `exp-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `exp-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    created.push(a, tenantB.id);
    branch = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    ownerCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" })).id);
    receptionCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" })).id);
    doctorCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. A" })).id);
    ownerBCookie = await sessionCookieFor((await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" })).id);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("suppliers", () => {
    it("are added by the desk, one of a name, with what is owed to each; the doctor sees none", async () => {
      const made = await suppliersPost(request("/api/suppliers", { method: "POST", cookie: receptionCookie, body: { name: "Saad Medical Trading", category: "SUPPLIES", phone: "+20 100 000 0000" } })).then(json);
      expect(made.res.status, JSON.stringify(made.json)).toBe(201);
      expect(made.json.supplier).toMatchObject({ name: "Saad Medical Trading", category: "SUPPLIES", categoryLabel: "Medical supplies", owed: 0, openBills: 0, archived: false });
      const twice = await suppliersPost(request("/api/suppliers", { method: "POST", cookie: receptionCookie, body: { name: "saad  medical trading" } })).then(json);
      expect(twice.res.status).toBe(409);
      expect((await suppliersPost(request("/api/suppliers", { method: "POST", cookie: receptionCookie, body: { name: "X", email: "not-mail" } }))).status).toBe(422);
      expect((await suppliersGet(request("/api/suppliers", { cookie: doctorCookie }))).status).toBe(403);
      const id = made.json.supplier.id;
      const archived = await supplierPatch(request(`/api/suppliers/${id}`, { method: "PATCH", cookie: receptionCookie, body: { name: "Saad Medical Trading", category: "SUPPLIES", archived: true } }), params(id)).then(json);
      expect(archived.json.supplier.archived).toBe(true);
      expect((await suppliersGet(request("/api/suppliers", { cookie: receptionCookie })).then(json)).json.suppliers.map((s: Json) => s.id)).not.toContain(id);
      expect((await suppliersGet(request("/api/suppliers?archived=1", { cookie: receptionCookie })).then(json)).json.suppliers.map((s: Json) => s.id)).toContain(id);
      await supplierPatch(request(`/api/suppliers/${id}`, { method: "PATCH", cookie: receptionCookie, body: { name: "Saad Medical Trading", category: "SUPPLIES", archived: false } }), params(id));
      expect((await supplierGet(request(`/api/suppliers/${id}`, { cookie: ownerBCookie }), params(id))).status).toBe(404);
      expect(await db.auditLog.count({ where: { tenantId: a, action: { in: ["supplier.create", "supplier.update"] } } })).toBe(3);
    });
  });

  describe("bills and payments", () => {
    it("a bill to pay by a day: paid in parts, never past its amount, owed again when a payment is voided", async () => {
      const bill = await create({ category: "SUPPLIES", description: "Gauze, gloves and syringes", amount: 9_000, supplierName: "Saad Medical Trading", billedOn: dayKey(-10), dueOn: dayKey(-2), reference: "INV-5521" });
      expect(bill.res.status, JSON.stringify(bill.json)).toBe(201);
      const id = bill.json.expense.id;
      expect(bill.json.expense).toMatchObject({ status: "OPEN", owed: 9_000, paid: 0, overdue: true, daysLate: 2, supplier: { name: "Saad Medical Trading" }, clinic: { id: branch } });
      // The supplier found by its name, not made twice.
      expect(await db.supplier.count({ where: { tenantId: a } })).toBe(1);
      const due = await list({ view: "due" });
      expect(due.json.list.rows.map((r: Json) => r.id)).toContain(id);
      expect(due.json.kpis).toMatchObject({ toPay: { amount: 9_000, bills: 1 }, overdue: { amount: 9_000, bills: 1 } });

      const part = await pay(id, { amount: 4_000, method: "BANK_TRANSFER", reference: "CIB 77" });
      expect(part.res.status, JSON.stringify(part.json)).toBe(201);
      expect(part.json.expense).toMatchObject({ status: "PART_PAID", paid: 4_000, owed: 5_000 });
      const over = await pay(id, { amount: 6_000, method: "BANK_TRANSFER" });
      expect(over.res.status).toBe(422);
      expect((await pay(id, { amount: 1_000, method: "BANK_TRANSFER", paidOn: dayKey(-11) })).res.status).toBe(422);
      expect((await pay(id, { amount: 1_000, method: "BANK_TRANSFER", paidOn: dayKey(1) })).res.status).toBe(422);
      const rest = await pay(id, { amount: 5_000, method: "INSTAPAY" });
      expect(rest.json.expense).toMatchObject({ status: "PAID", owed: 0, overdue: false });
      expect((await pay(id, { amount: 1, method: "CASH" })).json.error).toBe("paid_in_full");
      // The database holds the line too.
      await expect(db.expensePayment.create({ data: { tenantId: a, expenseId: id, clinicId: branch, amount: 1, method: "CASH", paidAt: new Date() } })).rejects.toThrow(/past its amount/);

      const first = rest.json.expense.payments[0];
      expect((await voidPayment(first.id, receptionCookie)).res.status).toBe(403);
      const voided = await voidPayment(first.id);
      expect(voided.json.expense).toMatchObject({ status: "PART_PAID", paid: 5_000, owed: 4_000 });
      expect((await voidPayment(first.id)).json.error).toBe("invalid_state");
      await expect(db.expensePayment.update({ where: { id: first.id }, data: { amount: 10 } })).rejects.toThrow(/never changes/);
      await expect(db.expensePayment.delete({ where: { id: first.id } })).rejects.toThrow(/never deleted/);

      // Corrected, never below what is paid; never a day ahead, never due before its day.
      expect((await edit(id, { category: "SUPPLIES", description: "Gauze", amount: 4_000, billedOn: dayKey(-10) })).res.status).toBe(422);
      expect((await edit(id, { category: "SUPPLIES", description: "Gauze", amount: 9_000, billedOn: dayKey(2) })).res.status).toBe(422);
      expect((await edit(id, { category: "SUPPLIES", description: "Gauze", amount: 9_000, billedOn: dayKey(-10), dueOn: dayKey(-12) })).res.status).toBe(422);
      const fixed = await edit(id, { category: "SUPPLIES", description: "Gauze and gloves", amount: 9_500, billedOn: dayKey(-10), dueOn: dayKey(5), supplierName: "Saad Medical Trading" });
      expect(fixed.json.expense).toMatchObject({ amount: 9_500, owed: 4_500, overdue: false, dueOn: dayKey(5) });
      await expect(db.expense.update({ where: { id }, data: { amount: 100 } })).rejects.toThrow(/never less than what is paid/);
      expect((await pay(id, { amount: 1_000, method: "CASH" }, doctorCookie)).res.status).toBe(403);
    });

    it("money spent at once is paid in full; cash out of the drawer needs the cashier's open shift, today's, and the drawer expects less", async () => {
      const outside = await create({ category: "HOSPITALITY", description: "Water and coffee for the waiting room", amount: 350, paid: { method: "CASH" } });
      expect(outside.json.expense).toMatchObject({ status: "PAID", paid: 350, payments: [expect.objectContaining({ fromDrawer: false, method: "CASH" })] });
      const noShift = await create({ category: "HOSPITALITY", description: "Tea", amount: 120, paid: { method: "CASH", fromDrawer: true } });
      expect(noShift.res.status).toBe(409);
      expect(noShift.json.error).toBe("no_shift");
      expect((await create({ category: "HOSPITALITY", description: "Tea", amount: 120, paid: { method: "CARD", fromDrawer: true } })).res.status).toBe(422);

      const opened = await openShiftRoute(request("/api/cash/shift", { method: "POST", cookie: receptionCookie, body: { openingFloat: 1_000 } })).then(json);
      expect(opened.res.status).toBe(201);
      expect((await create({ category: "HOSPITALITY", description: "Tea", amount: 120, billedOn: dayKey(-1), paid: { method: "CASH", fromDrawer: true } })).json.error).toBe("drawer_today");
      const tea = await create({ category: "HOSPITALITY", description: "Tea and sugar", amount: 120, paid: { method: "CASH", fromDrawer: true } });
      expect(tea.res.status, JSON.stringify(tea.json)).toBe(201);
      expect(tea.json.expense.payments[0]).toMatchObject({ fromDrawer: true, amount: 120 });
      expect(await cashExpected()).toBe(880);
      const bill = await create({ category: "CLEANING", description: "Window cleaning", amount: 600, dueOn: dayKey(3) });
      await pay(bill.json.expense.id, { amount: 200, method: "CASH", fromDrawer: true });
      expect((await shift()).json.shift).toMatchObject({ paidOut: { count: 2, amount: 320 } });
      expect(await cashExpected()).toBe(680);
      // Voided while the day is open: the drawer expects it back.
      const p = (await get(bill.json.expense.id)).json.expense.payments[0];
      await voidPayment(p.id);
      expect(await cashExpected()).toBe(880);

      // Counted, closed, the day signed off: the drawer's cash stays.
      const shiftId = (await shift()).json.shift.id;
      const closed = await closeShiftRoute(request(`/api/cash/shifts/${shiftId}/close`, { method: "POST", cookie: receptionCookie, body: { counts: [{ method: "CASH", counted: 880 }] } }), params(shiftId)).then(json);
      expect(closed.res.status, JSON.stringify(closed.json)).toBe(200);
      expect((await signOffRoute(request("/api/cash/day", { method: "POST", cookie: ownerCookie, body: { date: today() } }))).status).toBe(200);
      const kept = await voidPayment(tea.json.expense.payments[0].id);
      expect(kept.res.status).toBe(409);
      expect(kept.json.error).toBe("day_closed");
      expect((await voidIt(tea.json.expense.id)).json.error).toBe("day_closed");
      // Paid from elsewhere, the day signed off does not matter.
      expect((await voidIt(outside.json.expense.id)).res.status).toBe(200);
    });

    it("the owner voids an expense, its payments with it; voided it never changes and is never deleted", async () => {
      const e = await create({ category: "OTHER", description: "Entered twice", amount: 700, paid: { method: "BANK_TRANSFER" } });
      const id = e.json.expense.id;
      expect((await voidIt(id, receptionCookie)).res.status).toBe(403);
      const voided = await voidIt(id);
      expect(voided.json.expense).toMatchObject({ status: "VOID", owed: 0, voidReason: "Entered twice" });
      expect(voided.json.expense.payments[0].voidedAt).not.toBeNull();
      expect((await voidIt(id)).json.error).toBe("invalid_state");
      expect((await pay(id, { amount: 100, method: "CASH" })).json.error).toBe("invalid_state");
      expect((await edit(id, { category: "OTHER", description: "Again", amount: 700, billedOn: today() })).json.error).toBe("invalid_state");
      await expect(db.expense.update({ where: { id }, data: { description: "x" } })).rejects.toThrow(/never changes/);
      await expect(db.expense.delete({ where: { id } })).rejects.toThrow(/never deleted/);
      const voidedList = await list({ view: "voided" });
      expect(voidedList.json.list.rows.map((r: Json) => r.id)).toContain(id);
      expect((await list({ view: "month" })).json.list.rows.map((r: Json) => r.id)).not.toContain(id);
      expect(await db.auditLog.count({ where: { tenantId: a, action: "expense.void", entityId: id } })).toBe(1);
    });

    it("lists a month's expenses with its total, by category and by search", async () => {
      const month = await list({ view: "month" });
      expect(month.res.status).toBe(200);
      const rows = month.json.list.rows as Json[];
      expect(rows.length).toBeGreaterThan(0);
      expect(month.json.list.amount).toBe(rows.reduce((s, r) => s + r.amount, 0));
      expect(rows.every((r) => r.billedOn.slice(0, 7) === monthOfKey(today()))).toBe(true);
      expect((await list({ view: "month", category: "CLEANING" })).json.list.rows.every((r: Json) => r.category === "CLEANING")).toBe(true);
      expect((await list({ view: "month", q: "window" })).json.list.rows.map((r: Json) => r.description)).toEqual(["Window cleaning"]);
      expect((await list({ view: "month", month: shiftMonth(monthOfKey(today()), -1) })).json.list.rows.map((r: Json) => r.description)).not.toContain("Window cleaning");
      expect(month.json.kpis.byCategory.map((c: Json) => c.category)).toContain("CLEANING");
      expect((await list({}, doctorCookie)).res.status).toBe(403);
    });
  });

  describe("salaries", () => {
    it("are the owner's alone: the desk records none and sees none, in the lists, the figures or the files", async () => {
      expect((await create({ category: "SALARIES", description: "Nurse, October", amount: 14_000 })).res.status).toBe(403);
      const salary = await create({ category: "SALARIES", description: "Nurse's salary", amount: 14_000, dueOn: dayKey(1) }, ownerCookie);
      expect(salary.res.status).toBe(201);
      const id = salary.json.expense.id;
      expect((await attach(id, [{ name: "slip.png", data: PNG }], ownerCookie)).res.status).toBe(201);
      const fileId = (await get(id)).json.expense.files[0].id;
      const desk = await list({ view: "due" }, receptionCookie);
      expect(desk.json.list.rows.map((r: Json) => r.id)).not.toContain(id);
      const owner = await list({ view: "due" });
      expect(owner.json.list.rows.map((r: Json) => r.id)).toContain(id);
      expect(owner.json.kpis.toPay.amount - desk.json.kpis.toPay.amount).toBe(14_000);
      expect((await get(id, receptionCookie)).res.status).toBe(404);
      expect((await pay(id, { amount: 100, method: "CASH" })).res.status).toBe(404);
      expect((await fileGet(request(`/api/expense-files/${fileId}`, { cookie: receptionCookie }), params(fileId))).status).toBe(404);
      const other = (await create({ category: "OTHER", description: "Stamps", amount: 50, paid: { method: "CASH" } })).json.expense.id;
      expect((await edit(other, { category: "SALARIES", description: "Stamps", amount: 50, billedOn: today() })).res.status).toBe(403);
    });
  });

  describe("receipts", () => {
    it("a photo or a PDF, typed by its bytes, served to whoever may see the expense; the owner removes one put by mistake", async () => {
      const e = await create({ category: "MAINTENANCE", description: "Laser hand-piece repair", amount: 4_500, dueOn: dayKey(7), files: [{ name: "quote.png", type: "image/png", data: PNG }] });
      expect(e.res.status, JSON.stringify(e.json)).toBe(201);
      const id = e.json.expense.id;
      expect(e.json.expense.files).toEqual([expect.objectContaining({ mimeType: "image/png", name: "quote.png" })]);
      const pdf = await attach(id, [{ name: "invoice.pdf", type: "application/pdf", data: PDF }]);
      expect(pdf.res.status).toBe(201);
      expect(pdf.json.expense.files.map((f: Json) => f.mimeType)).toEqual(["image/png", "application/pdf"]);
      const fake = await attach(id, [{ name: "evil.png", type: "image/png", data: Buffer.from("<script>alert(1)</script>").toString("base64") }]);
      expect(fake.res.status).toBe(422);
      expect(fake.json.error).toBe("file_type");
      const big = await attach(id, [{ name: "big.jpg", data: Buffer.alloc(5 * 1024 * 1024 + 10, 0xff).toString("base64") }]);
      expect(big.res.status).toBe(422);
      expect((await attach(id, [], receptionCookie)).res.status).toBe(422);

      const [photo, doc] = pdf.json.expense.files as Json[];
      const served = await fileGet(request(`/api/expense-files/${photo!.id}`, { cookie: receptionCookie }), params(photo!.id));
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("content-disposition")).toMatch(/^inline/);
      expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(PNG, "base64"))).toBe(true);
      expect((await fileGet(request(`/api/expense-files/${doc!.id}`, { cookie: receptionCookie }), params(doc!.id))).headers.get("content-disposition")).toMatch(/^attachment/);
      expect((await fileGet(request(`/api/expense-files/${photo!.id}`, { cookie: doctorCookie }), params(photo!.id))).status).toBe(403);
      expect((await fileGet(request(`/api/expense-files/${photo!.id}`, { cookie: ownerBCookie }), params(photo!.id))).status).toBe(404);

      expect((await fileDelete(request(`/api/expense-files/${photo!.id}`, { method: "DELETE", cookie: receptionCookie }), params(photo!.id))).status).toBe(403);
      const removed = await fileDelete(request(`/api/expense-files/${photo!.id}`, { method: "DELETE", cookie: ownerCookie }), params(photo!.id)).then(json);
      expect(removed.json.expense.files.map((f: Json) => f.id)).toEqual([doc!.id]);
      expect(await db.fileBlob.count({ where: { tenantId: a, id: { in: [photo!.id] } } })).toBe(0);
    });
  });

  describe("recurring expenses", () => {
    it("make one bill a month on their day, at the amount they have then; stopped, no more", async () => {
      const thisMonth = monthOfKey(today());
      const start = shiftMonth(thisMonth, -2);
      const body = { category: "RENT", description: "Clinic rent", amount: 60_000, everyMonths: 1, dayOfMonth: 1, dueDays: 5, startMonth: start, supplierName: "Hany Saad (landlord)" };
      expect((await recurringPost(request("/api/recurring-expenses", { method: "POST", cookie: receptionCookie, body }))).status).toBe(403);
      expect((await recurringPost(request("/api/recurring-expenses", { method: "POST", cookie: ownerCookie, body: { ...body, dayOfMonth: 31 } }))).status).toBe(422);
      expect((await recurringPost(request("/api/recurring-expenses", { method: "POST", cookie: ownerCookie, body: { ...body, startMonth: shiftMonth(thisMonth, -13) } }))).status).toBe(422);
      const made = await recurringPost(request("/api/recurring-expenses", { method: "POST", cookie: ownerCookie, body })).then(json);
      expect(made.res.status, JSON.stringify(made.json)).toBe(201);
      const r = made.json.recurring;
      expect(r).toMatchObject({ made: 3, amount: 60_000, nextOn: `${shiftMonth(thisMonth, 1)}-01`, supplier: { name: "Hany Saad (landlord)" } });
      const bills = await db.expense.findMany({ where: { tenantId: a, recurringId: r.id }, orderBy: { billedOn: "asc" } });
      expect(bills.map((b) => b.period)).toEqual([start, shiftMonth(thisMonth, -1), thisMonth]);
      expect(bills.map((b) => b.dueOn?.toISOString().slice(0, 10))).toEqual([`${start}-06`, `${shiftMonth(thisMonth, -1)}-06`, `${thisMonth}-06`]);
      // Once a month, however often the job runs.
      expect((await makeRecurringBills(a)).made).toBe(0);
      await expect(db.expense.create({ data: { tenantId: a, clinicId: branch, category: "RENT", description: "x", billedOn: bills[0]!.billedOn, amount: 1, recurringId: r.id, period: start } })).rejects.toThrow();

      // A new amount from now on; the bills made stay.
      const raised = await recurringPatch(request(`/api/recurring-expenses/${r.id}`, { method: "PATCH", cookie: ownerCookie, body: { category: "RENT", description: "Clinic rent", amount: 66_000, dueDays: 5, supplierId: r.supplier.id } }), params(r.id)).then(json);
      expect(raised.json.recurring.amount).toBe(66_000);
      const nextMonthDay = fromDateKey(`${shiftMonth(thisMonth, 1)}-01`, TZ)!;
      expect((await makeRecurringBills(a, new Date(nextMonthDay.getTime() + 10 * 3_600_000))).made).toBe(1);
      expect((await db.expense.findFirstOrThrow({ where: { tenantId: a, recurringId: r.id, period: shiftMonth(thisMonth, 1) } })).amount).toBe(66_000);
      expect((await db.expense.findFirstOrThrow({ where: { tenantId: a, recurringId: r.id, period: thisMonth } })).amount).toBe(60_000);

      expect((await recurringStop(request(`/api/recurring-expenses/${r.id}/stop`, { method: "POST", cookie: receptionCookie, body: { reason: "Moved" } }), params(r.id))).status).toBe(403);
      const stopped = await recurringStop(request(`/api/recurring-expenses/${r.id}/stop`, { method: "POST", cookie: ownerCookie, body: { reason: "We moved to the new branch" } }), params(r.id)).then(json);
      expect(stopped.json.recurring).toMatchObject({ nextOn: null, stopReason: "We moved to the new branch" });
      const later = fromDateKey(`${shiftMonth(thisMonth, 3)}-02`, TZ)!;
      expect((await makeRecurringBills(a, later)).made).toBe(0);
      await expect(db.recurringExpense.update({ where: { id: r.id }, data: { amount: 1 } })).rejects.toThrow(/never changes/);
      await expect(db.recurringExpense.delete({ where: { id: r.id } })).rejects.toThrow(/never deleted/);
      const listed = await recurringGet(request("/api/recurring-expenses", { cookie: receptionCookie })).then(json);
      expect(listed.json.recurring.map((x: Json) => x.id)).toContain(r.id);
      expect(await db.auditLog.count({ where: { tenantId: a, action: { in: ["expense.recurring_create", "expense.recurring_update", "expense.recurring_stop"] } } })).toBe(3);
    });
  });

  describe("isolation", () => {
    it("another clinic's expense is not there: not read, paid, changed or voided", async () => {
      const e = await create({ category: "OTHER", description: "Postage", amount: 80, dueOn: dayKey(2) });
      const id = e.json.expense.id;
      expect((await get(id, ownerBCookie)).res.status).toBe(404);
      expect((await pay(id, { amount: 10, method: "CASH" }, ownerBCookie)).res.status).toBe(404);
      expect((await edit(id, { category: "OTHER", description: "Postage", amount: 80, billedOn: today() }, ownerBCookie)).res.status).toBe(404);
      expect((await voidIt(id, ownerBCookie)).res.status).toBe(404);
      expect((await list({ view: "due" }, ownerBCookie)).json.list.rows).toEqual([]);
      const supplierId = (await db.supplier.findFirstOrThrow({ where: { tenantId: a } })).id;
      expect((await create({ category: "OTHER", description: "Postage", amount: 10, supplierId }, ownerBCookie)).res.status).toBe(404);
    });
  });
});

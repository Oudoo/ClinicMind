/**
 * Lab work (Phase 5) over the real route handlers and the test database:
 * orders from a procedure or not, where on the body, due back by the lab's
 * usual days; a new lab by its name; results recorded by the clinicians only
 * (the desk sees where an order stands, never the result), the doctor who
 * asked told; late orders told once to the doctor and the desk; the lab's
 * bill as an expense and a cost on the procedure, voiding one voids the
 * other, a voided bill replaced; cancelling with a reason, never deleting;
 * the lists, RBAC and isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { dateKeyInTz } from "@/lib/time";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { notifyLateLabOrders } from "@/modules/lab/orders";
import { GET as ordersGet, POST as ordersPost } from "@/app/api/lab-orders/route";
import { GET as optionsGet } from "@/app/api/lab-orders/options/route";
import { GET as orderGet, PATCH as orderPatch } from "@/app/api/lab-orders/[id]/route";
import { POST as resultPost } from "@/app/api/lab-orders/[id]/result/route";
import { POST as filesPost } from "@/app/api/lab-orders/[id]/files/route";
import { POST as cancelPost } from "@/app/api/lab-orders/[id]/cancel/route";
import { POST as billPost } from "@/app/api/lab-orders/[id]/bill/route";
import { GET as labFileGet } from "@/app/api/lab-order-files/[id]/route";
import { GET as labsGet } from "@/app/api/labs/route";
import { POST as expenseVoid } from "@/app/api/expenses/[id]/void/route";
import { POST as costVoid } from "@/app/api/procedure-costs/[id]/void/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const dayKey = (offset: number) => dateKeyInTz(new Date(Date.now() + offset * 86_400_000), TZ);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe.skipIf(!dbTestsEnabled)("lab work routes", () => {
  const created: string[] = [];
  let a: string;
  let lab: string;
  let patient: string;
  let otherPatient: string;
  let procedure: string;
  let doctorId: string;
  let ownerCookie: string;
  let doctorCookie: string;
  let nurseCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;

  type Json = Record<string, any>;
  const json = async (res: Response) => ({ res, json: (await res.json()) as Json });
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const create = (body: Record<string, unknown>, cookie = doctorCookie) => ordersPost(request("/api/lab-orders", { method: "POST", cookie, body })).then(json);
  const get = (id: string, cookie = doctorCookie) => orderGet(request(`/api/lab-orders/${id}`, { cookie }), params(id)).then(json);
  const result = (id: string, body: Record<string, unknown>, cookie = doctorCookie) => resultPost(request(`/api/lab-orders/${id}/result`, { method: "POST", cookie, body }), params(id)).then(json);
  const bill = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => billPost(request(`/api/lab-orders/${id}/bill`, { method: "POST", cookie, body }), params(id)).then(json);
  const cancel = (id: string, cookie = receptionCookie) => cancelPost(request(`/api/lab-orders/${id}/cancel`, { method: "POST", cookie, body: { reason: "Done at another lab" } }), params(id)).then(json);
  const list = (query: Record<string, string>, cookie = receptionCookie) => ordersGet(request(`/api/lab-orders?${new URLSearchParams(query).toString()}`, { cookie })).then(json);

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `lab-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `lab-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    created.push(a, tenantB.id);
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Biopsy" });
    doctorId = doctor.id;
    doctorCookie = await sessionCookieFor(doctor.id);
    ownerCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" })).id);
    nurseCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse A" })).id);
    receptionCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" })).id);
    assistantCookie = await sessionCookieFor((await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" })).id);
    ownerBCookie = await sessionCookieFor((await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER", fullName: "Owner B" })).id);
    lab = (await db.supplier.create({ data: { tenantId: a, name: "Lotus Pathology", category: "LAB", isLab: true, turnaroundDays: 7 } })).id;
    patient = (await db.patient.create({ data: { tenantId: a, fullName: "Salma Biopsy", phone: "+201006600001" } })).id;
    otherPatient = (await db.patient.create({ data: { tenantId: a, fullName: "Omar Bloods", phone: "+201006600002" } })).id;
    await ensureDefaultTreatments(a);
    const treatment = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "general-dermatology" } })).id;
    procedure = (await db.procedure.create({ data: { tenantId: a, patientId: patient, treatmentId: treatment, doctorId, performedAt: new Date(Date.now() - 3 * 86_400_000), price: 1_500, status: "SIGNED", signedAt: new Date() } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("sends an order from a procedure, due back by the lab's usual days; a new lab by its name; the desk and the nurse send too", async () => {
    const made = await create({ patientId: patient, labId: lab, procedureId: procedure, tests: "Histopathology", site: "Left cheek", sentOn: dayKey(-1) });
    expect(made.res.status, JSON.stringify(made.json)).toBe(201);
    expect(made.json.order).toMatchObject({ status: "SENT", statusLabel: "At the lab", dueOn: dayKey(6), late: false, site: "Left cheek", doctor: { id: doctorId }, procedure: { id: procedure }, lab: { name: "Lotus Pathology" } });
    expect(await db.timelineEvent.count({ where: { tenantId: a, patientId: patient, kind: "LAB", refId: made.json.order.id } })).toBe(1);
    // The desk sends one: who asked is the procedure's doctor.
    const desk = await create({ patientId: patient, labId: lab, procedureId: procedure, tests: "Fungal culture" }, receptionCookie);
    expect(desk.json.order.doctor).toMatchObject({ id: doctorId });
    const fresh = await create({ patientId: otherPatient, labName: "Mena Medical Lab", tests: "Lipid profile, ALT, AST" }, nurseCookie);
    expect(fresh.res.status).toBe(201);
    expect(fresh.json.order.doctor).toBeNull();
    expect(await db.supplier.findFirst({ where: { tenantId: a, name: "Mena Medical Lab" }, select: { isLab: true, category: true } })).toEqual({ isLab: true, category: "LAB" });
    expect((await labsGet(request("/api/labs", { cookie: receptionCookie })).then(json)).json.labs.map((l: Json) => l.name)).toEqual(["Lotus Pathology", "Mena Medical Lab"]);
    // Refused: no lab, a procedure of someone else, a day ahead, due before it went, the assistant.
    expect((await create({ patientId: patient, tests: "Bloods" })).res.status).toBe(422);
    expect((await create({ patientId: otherPatient, labId: lab, procedureId: procedure, tests: "Bloods" })).res.status).toBe(404);
    expect((await create({ patientId: patient, labId: lab, tests: "Bloods", sentOn: dayKey(1) })).res.status).toBe(422);
    expect((await create({ patientId: patient, labId: lab, tests: "Bloods", sentOn: dayKey(-2), dueOn: dayKey(-3) })).res.status).toBe(422);
    expect((await create({ patientId: patient, labId: lab, tests: "Bloods" }, assistantCookie)).res.status).toBe(403);
    const options = await optionsGet(request(`/api/lab-orders/options?patientId=${patient}`, { cookie: receptionCookie })).then(json);
    expect(options.json.procedures.map((p: Json) => p.id)).toEqual([procedure]);
    expect(await db.auditLog.count({ where: { tenantId: a, action: "lab.order_create" } })).toBe(3);
  });

  it("records the result for the clinicians only: the desk sees it is in, never what it says; the doctor who asked is told", async () => {
    const o = (await create({ patientId: patient, labId: lab, procedureId: procedure, tests: "Histopathology, punch biopsy", site: "Scalp" })).json.order;
    expect((await result(o.id, { result: "Lichen planopilaris" }, receptionCookie)).res.status).toBe(403);
    const before = await db.notification.count({ where: { tenantId: a, userId: doctorId, kind: "LAB_RESULT_IN" } });
    const done = await result(o.id, { result: "Lichen planopilaris, active", abnormal: true, files: [{ name: "report.png", data: PNG }] }, nurseCookie);
    expect(done.res.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.order).toMatchObject({ status: "RECEIVED", result: "Lichen planopilaris, active", abnormal: true, resultsVisible: true });
    expect(done.json.order.files).toHaveLength(1);
    const told = await db.notification.findMany({ where: { tenantId: a, userId: doctorId, kind: "LAB_RESULT_IN" }, orderBy: { createdAt: "desc" } });
    expect(told.length).toBe(before + 1);
    expect(told[0]).toMatchObject({ level: "WARNING", href: `/dashboard/lab/${o.id}` });
    const desk = await get(o.id, receptionCookie);
    expect(desk.json.order).toMatchObject({ status: "RECEIVED", resultsVisible: false, result: null, abnormal: null, files: [] });
    const fileId = done.json.order.files[0].id;
    expect((await labFileGet(request(`/api/lab-order-files/${fileId}`, { cookie: doctorCookie }), params(fileId))).status).toBe(200);
    expect((await labFileGet(request(`/api/lab-order-files/${fileId}`, { cookie: receptionCookie }), params(fileId))).status).toBe(404);
    expect((await labFileGet(request(`/api/lab-order-files/${fileId}`, { cookie: ownerBCookie }), params(fileId))).status).toBe(404);
    // Recorded again: corrected, the doctor not told twice.
    const fixed = await result(o.id, { result: "Lichen planopilaris, active; no malignancy" , abnormal: true });
    expect(fixed.json.order.result).toBe("Lichen planopilaris, active; no malignancy");
    expect(await db.notification.count({ where: { tenantId: a, userId: doctorId, kind: "LAB_RESULT_IN" } })).toBe(before + 1);
    expect(await db.auditLog.count({ where: { tenantId: a, action: "lab.result_amend", entityId: o.id } })).toBe(1);
    expect((await filesPost(request(`/api/lab-orders/${o.id}/files`, { method: "POST", cookie: receptionCookie, body: { files: [{ data: PNG }] } }), params(o.id))).status).toBe(403);
    expect((await cancel(o.id)).json.error).toBe("invalid_state");
  });

  it("tells the doctor who asked and the desk, once, of an order late back; a new day starts it again", async () => {
    const o = (await create({ patientId: otherPatient, labId: lab, tests: "Pre-op bloods: CBC, PT/INR", sentOn: dayKey(-10) })).json.order;
    expect(o).toMatchObject({ late: true, daysLate: 3, dueOn: dayKey(-3) });
    const late = await list({ view: "late" });
    expect(late.json.list.rows.map((r: Json) => r.id)).toContain(o.id);
    expect(late.json.kpis.late).toBeGreaterThanOrEqual(1);
    const first = await notifyLateLabOrders(new Date(), { tenantId: a });
    expect(first.late).toBeGreaterThanOrEqual(1);
    const told = await db.notification.findMany({ where: { tenantId: a, kind: "LAB_ORDER_LATE" }, select: { userId: true, href: true } });
    const desk = await db.user.findFirstOrThrow({ where: { tenantId: a, role: "RECEPTIONIST" }, select: { id: true } });
    expect(told.map((t) => t.userId)).toEqual(expect.arrayContaining([doctorId, desk.id]));
    expect((await notifyLateLabOrders(new Date(), { tenantId: a })).late).toBe(0);
    // Given a new day, it is late again only once that day passes.
    const moved = await orderPatch(request(`/api/lab-orders/${o.id}`, { method: "PATCH", cookie: receptionCookie, body: { tests: o.tests, dueOn: dayKey(2) } }), params(o.id)).then(json);
    expect(moved.json.order).toMatchObject({ late: false, dueOn: dayKey(2) });
    expect((await notifyLateLabOrders(new Date(), { tenantId: a })).late).toBe(0);
    expect((await notifyLateLabOrders(new Date(Date.now() + 4 * 86_400_000), { tenantId: a })).late).toBeGreaterThanOrEqual(1);
  });

  it("bills an order: an expense under Lab fees and a cost on its procedure; voiding one voids the other; a voided bill is replaced", async () => {
    const o = (await create({ patientId: patient, labId: lab, procedureId: procedure, tests: "Histopathology, shave biopsy" })).json.order;
    expect((await bill(o.id, { amount: 1_200 }, doctorCookie)).res.status).toBe(403);
    const billed = await bill(o.id, { amount: 1_200, reference: "LP-2210", dueOn: dayKey(20) });
    expect(billed.res.status, JSON.stringify(billed.json)).toBe(201);
    expect(billed.json.order.bill).toMatchObject({ amount: 1_200, paid: 0, owed: 1_200 });
    const row = await db.labOrder.findUniqueOrThrow({ where: { id: o.id }, select: { expenseId: true, costId: true } });
    expect(await db.expense.findUniqueOrThrow({ where: { id: row.expenseId! }, select: { category: true, supplierId: true, amount: true, description: true } })).toEqual({ category: "LAB", supplierId: lab, amount: 1_200, description: "Histopathology, shave biopsy · Salma Biopsy" });
    expect(await db.procedureCost.findUniqueOrThrow({ where: { id: row.costId! }, select: { kind: true, amount: true, procedureId: true, voidedAt: true } })).toEqual({ kind: "LAB", amount: 1_200, procedureId: procedure, voidedAt: null });
    expect((await bill(o.id, { amount: 1_200 })).json.error).toBe("billed");
    expect((await cancel(o.id)).json.error).toBe("billed");

    // The owner voids the expense: its cost goes with it; a new bill can be entered.
    await expenseVoid(request(`/api/expenses/${row.expenseId}/void`, { method: "POST", cookie: ownerCookie, body: { reason: "Wrong amount" } }), params(row.expenseId!));
    expect((await db.procedureCost.findUniqueOrThrow({ where: { id: row.costId! } })).voidReason).toBe("The lab's bill was voided: Wrong amount");
    expect((await get(o.id)).json.order).toMatchObject({ bill: null, billVoided: true });
    const again = await bill(o.id, { amount: 1_100, paid: { method: "BANK_TRANSFER" } });
    expect(again.json.order.bill).toMatchObject({ amount: 1_100, paid: 1_100, owed: 0 });
    // Voiding the procedure's cost voids the bill.
    const now = await db.labOrder.findUniqueOrThrow({ where: { id: o.id }, select: { expenseId: true, costId: true } });
    expect(now.expenseId).not.toBe(row.expenseId);
    await costVoid(request(`/api/procedure-costs/${now.costId}/void`, { method: "POST", cookie: ownerCookie, body: { reason: "The lab did not charge us" } }), params(now.costId!));
    const voided = await db.expense.findUniqueOrThrow({ where: { id: now.expenseId! }, select: { voidedAt: true, payments: { select: { voidedAt: true } } } });
    expect(voided.voidedAt).not.toBeNull();
    expect(voided.payments.every((p) => p.voidedAt)).toBe(true);
    // An order without a procedure: an expense only.
    const bloods = (await create({ patientId: otherPatient, labId: lab, tests: "Lipid profile" })).json.order;
    await bill(bloods.id, { amount: 650 });
    expect((await db.labOrder.findUniqueOrThrow({ where: { id: bloods.id }, select: { costId: true } })).costId).toBeNull();
    expect((await list({ view: "unbilled" })).json.list.rows.map((r: Json) => r.id)).toContain(o.id);
  });

  it("cancels an order at the lab with the reason, never deletes it; lists and searches", async () => {
    const o = (await create({ patientId: otherPatient, labId: lab, tests: "Vitamin D level" })).json.order;
    const cancelled = await cancel(o.id);
    expect(cancelled.json.order).toMatchObject({ status: "CANCELLED", cancelReason: "Done at another lab" });
    expect((await cancel(o.id)).json.error).toBe("invalid_state");
    await expect(db.labOrder.update({ where: { id: o.id }, data: { tests: "x" } })).rejects.toThrow(/never changes/);
    await expect(db.labOrder.delete({ where: { id: o.id } })).rejects.toThrow(/never deleted/);
    expect((await list({ view: "cancelled" })).json.list.rows.map((r: Json) => r.id)).toEqual([o.id]);
    expect((await list({ view: "waiting", q: "salma" })).json.list.rows.every((r: Json) => r.patient.fullName === "Salma Biopsy")).toBe(true);
    expect((await list({ view: "back" }, doctorCookie)).json.kpis.flagged).toBeGreaterThanOrEqual(1);
    expect((await list({ view: "back" })).json.kpis.flagged).toBeNull();
    expect((await list({ view: "waiting" }, assistantCookie)).res.status).toBe(403);
  });

  it("another clinic's order is not there", async () => {
    const o = (await create({ patientId: patient, labId: lab, tests: "Culture" })).json.order;
    expect((await get(o.id, ownerBCookie)).res.status).toBe(404);
    expect((await result(o.id, { result: "x y" }, ownerBCookie)).res.status).toBe(404);
    expect((await bill(o.id, { amount: 100 }, ownerBCookie)).res.status).toBe(404);
    expect((await cancel(o.id, ownerBCookie)).res.status).toBe(404);
    expect((await create({ patientId: patient, labId: lab, tests: "Culture" }, ownerBCookie)).res.status).toBe(404);
    expect((await list({ view: "waiting" }, ownerBCookie)).json.list.rows).toEqual([]);
  });
});

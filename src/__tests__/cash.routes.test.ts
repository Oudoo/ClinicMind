/**
 * The cash drawer over the real route handlers and the test database: a
 * cashier opens one shift at a time with the float; money dated today is
 * taken only in an open shift (a deposit with a procedure too) and goes into
 * it; money entered late for an earlier day belongs to no shift; a shift left
 * open from an earlier day takes nothing more; the close counts every method
 * that moved, a difference needs its reason, and a closed shift never changes;
 * the owner sees the day (the shifts, the money outside them, the totals) and
 * signs it off once every shift is closed, after which nothing is recorded on
 * it or voided from it, by the service and by the database, imports included;
 * each branch's day on its own. RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, fromDateKey } from "@/lib/time";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { GET as myShiftRoute, POST as openShiftRoute } from "@/app/api/cash/shift/route";
import { POST as closeShiftRoute } from "@/app/api/cash/shifts/[id]/close/route";
import { GET as dayRoute, POST as signOffRoute } from "@/app/api/cash/day/route";
import { POST as paymentRoute } from "@/app/api/payments/route";
import { POST as voidRoute } from "@/app/api/payments/[id]/void/route";
import { POST as importRoute } from "@/app/api/payments/import/route";
import { POST as confirmRoute } from "@/app/api/payments/import/confirm/route";
import { POST as createProcedureRoute } from "@/app/api/procedures/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
/** The day `n` days before today on the clinic's clock, and a time on it. */
const dayKey = (n: number) => dateKeyInTz(addDays(new Date(), -n, TZ), TZ);
const onDay = (n: number, hour = 12) => new Date(fromDateKey(dayKey(n), TZ)!.getTime() + hour * 3_600_000);

interface Line {
  method: string;
  expected: number;
  counted: number | null;
  difference: number | null;
  reason: string | null;
  expectedAtCount: number | null;
}
interface Shift {
  id: string;
  clinicId: string;
  status: string;
  cashier: { fullName: string };
  payments: number;
  methods: Line[];
  note: string | null;
}

describe.skipIf(!dbTestsEnabled)("cash drawer routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let branch: string;
  let branch2: string;
  let acne: string;
  let doctorId: string;
  let deskCId: string;
  let nurseId: string;
  let patient: string;
  let ownerCookie: string;
  let receptionCookie: string;
  let reception2Cookie: string;
  let deskCCookie: string;
  let nurseCookie: string;
  let doctorCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let shiftId: string;
  let cashPayment: string;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const mine = (cookie: string) => myShiftRoute(request("/api/cash/shift", { cookie })).then(json);
  const open = (body: Record<string, unknown>, cookie = receptionCookie) => openShiftRoute(request("/api/cash/shift", { method: "POST", cookie, body })).then(json);
  const close = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => closeShiftRoute(request(`/api/cash/shifts/${id}/close`, { method: "POST", cookie, body }), params(id)).then(json);
  const day = (query: Record<string, string> = {}, cookie = ownerCookie) => dayRoute(request(`/api/cash/day?${new URLSearchParams(query).toString()}`, { cookie })).then(json);
  const signOff = (body: Record<string, unknown>, cookie = ownerCookie) => signOffRoute(request("/api/cash/day", { method: "POST", cookie, body })).then(json);
  const pay = (body: Record<string, unknown>, cookie = receptionCookie) => paymentRoute(request("/api/payments", { method: "POST", cookie, body: { patientId: patient, kind: "PAYMENT", method: "CASH", ...body } })).then(json);
  const voidIt = (id: string, cookie = ownerCookie) => voidRoute(request(`/api/payments/${id}/void`, { method: "POST", cookie, body: { reason: "Entered twice" } }), params(id)).then(json);
  const line = (shift: Shift, method: string) => shift.methods.find((m) => m.method === method);

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `cash-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `cash-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    branch = (await db.clinic.findFirstOrThrow({ where: { tenantId: a } })).id;
    await db.clinic.update({ where: { id: branch }, data: { name: "Test Clinic — Zamalek" } });
    branch2 = (await db.clinic.create({ data: { tenantId: a, name: "Test Clinic — Dokki" } })).id;
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const reception2 = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk B" });
    const deskC = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk C" });
    const nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorId = doctor.id;
    deskCId = deskC.id;
    nurseId = nurse.id;
    ownerCookie = await sessionCookieFor(owner.id);
    receptionCookie = await sessionCookieFor(reception.id);
    reception2Cookie = await sessionCookieFor(reception2.id);
    deskCCookie = await sessionCookieFor(deskC.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    patient = (await db.patient.create({ data: { tenantId: a, fullName: "Cash Patient", phone: "+201001112299" } })).id;
    await ensureDefaultTreatments(a);
    acne = (await db.treatment.findFirstOrThrow({ where: { tenantId: a, key: "acne" } })).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("a cashier's shift", () => {
    it("opens with the cash in the drawer, one at a time; not for roles that take no money", async () => {
      expect((await mine(receptionCookie)).json).toEqual({ shift: null });
      expect((await open({ openingFloat: -5 })).res.status).toBe(422);
      expect((await open({ openingFloat: 12.5 })).res.status).toBe(422);
      expect((await open({ openingFloat: 500 }, doctorCookie)).res.status).toBe(403);
      expect((await open({ openingFloat: 500 }, assistantCookie)).res.status).toBe(403);
      expect((await mine(doctorCookie)).res.status).toBe(403);

      const opened = await open({ openingFloat: 500 });
      expect(opened.res.status).toBe(201);
      const shift = opened.json.shift as Shift;
      expect(shift).toMatchObject({ status: "OPEN", clinicId: branch, payments: 0, cashier: { fullName: "Desk A" } });
      expect(shift.methods).toEqual([expect.objectContaining({ method: "CASH", expected: 500, counted: null, difference: null })]);
      shiftId = shift.id;

      const again = await open({ openingFloat: 100 });
      expect(again.res.status).toBe(409);
      expect(again.json.error).toBe("shift_open");
      expect((await mine(receptionCookie)).json.shift.id).toBe(shiftId);
      expect(await db.auditLog.count({ where: { tenantId: a, action: "cash.shift.open", entityId: shiftId } })).toBe(1);
      // One open shift per cashier, whatever writes it.
      const receptionId = (await db.cashShift.findUniqueOrThrow({ where: { id: shiftId } })).userId;
      await expect(db.cashShift.create({ data: { tenantId: a, clinicId: branch, userId: receptionId, openedAt: new Date() } })).rejects.toThrow();
    });

    it("takes today's money only in an open shift and puts it there; money entered late is in none", async () => {
      const noShift = await pay({ amount: 300 }, nurseCookie);
      expect(noShift.res.status).toBe(409);
      expect(noShift.json).toMatchObject({ error: "no_shift" });
      expect(noShift.json.message).toContain("Open your shift first");

      const late = await pay({ amount: 250, paidAt: onDay(2).toISOString() }, nurseCookie);
      expect(late.res.status).toBe(201);
      expect((await db.payment.findUniqueOrThrow({ where: { id: late.json.payment.id } })).shiftId).toBeNull();
      // Entered late, the money is in no drawer: booked at its visit's branch, not the cashier's.
      const visit = await db.appointment.create({ data: { tenantId: a, clinicId: branch2, patientId: patient, startsAt: onDay(2, 10), endsAt: onDay(2, 11), status: "COMPLETED" } });
      const lateAtDokki = await pay({ amount: 350, paidAt: onDay(2, 13).toISOString(), appointmentId: visit.id });
      expect(lateAtDokki.res.status).toBe(201);
      expect(await db.payment.findUniqueOrThrow({ where: { id: lateAtDokki.json.payment.id } })).toMatchObject({ clinicId: branch2, shiftId: null });

      const ahead = await pay({ amount: 300, paidAt: new Date(Date.now() + 3_600_000).toISOString() });
      expect(ahead.res.status).toBe(422);
      expect(JSON.stringify(ahead.json)).toContain("paidAt");

      const cash = await pay({ amount: 1_200 });
      expect(cash.res.status).toBe(201);
      cashPayment = cash.json.payment.id;
      expect((await db.payment.findUniqueOrThrow({ where: { id: cashPayment } })).shiftId).toBe(shiftId);
      expect((await pay({ amount: 3_000, method: "CARD", reference: "POS-1" })).res.status).toBe(201);

      // A deposit taken with a procedure goes into the shift too.
      const procedure = await createProcedureRoute(
        request("/api/procedures", { method: "POST", cookie: receptionCookie, body: { patientId: patient, treatmentId: acne, doctorId, performedAt: new Date().toISOString(), price: 2_000, deposit: { amount: 400 } } }),
      ).then(json);
      expect(procedure.res.status).toBe(201);
      const deposit = await db.payment.findFirstOrThrow({ where: { tenantId: a, kind: "DEPOSIT", procedureId: procedure.json.procedure.id } });
      expect(deposit.shiftId).toBe(shiftId);

      const shift = (await mine(receptionCookie)).json.shift as Shift;
      expect(shift.payments).toBe(3);
      expect(line(shift, "CASH")?.expected).toBe(500 + 1_200 + 400);
      expect(line(shift, "CARD")?.expected).toBe(3_000);
    });

    it("closes with the count of every method that moved; a difference needs its reason; then it never changes", async () => {
      const deskB = await open({ openingFloat: 0 }, reception2Cookie);
      expect(deskB.res.status).toBe(201);
      // Taken today, the money is booked where the drawer is, whichever branch the visit was at.
      const visit = await db.appointment.create({ data: { tenantId: a, clinicId: branch2, patientId: patient, startsAt: new Date(Date.now() - 2 * 3_600_000), endsAt: new Date(Date.now() - 3_600_000) } });
      const atDesk = await pay({ amount: 100, appointmentId: visit.id }, reception2Cookie);
      expect(atDesk.res.status).toBe(201);
      expect(await db.payment.findUniqueOrThrow({ where: { id: atDesk.json.payment.id } })).toMatchObject({ clinicId: branch, shiftId: deskB.json.shift.id });
      const notYours = await close(shiftId, { counts: [{ method: "CASH", counted: 2_100 }, { method: "CARD", counted: 3_000 }] }, reception2Cookie);
      expect(notYours.res.status).toBe(403);
      expect(notYours.json.error).toBe("not_your_shift");

      const uncounted = await close(shiftId, { counts: [{ method: "CASH", counted: 2_100 }] });
      expect(uncounted.res.status).toBe(422);
      expect(JSON.stringify(uncounted.json)).toContain("Count the card");
      const unexplained = await close(shiftId, { counts: [{ method: "CASH", counted: 2_050 }, { method: "CARD", counted: 3_000 }] });
      expect(unexplained.res.status).toBe(422);
      expect(JSON.stringify(unexplained.json)).toContain("short by 50 EGP");

      const closed = await close(shiftId, { counts: [{ method: "CASH", counted: 2_050, reason: "Change given short" }, { method: "CARD", counted: 3_000 }], note: "Busy evening" });
      expect(closed.res.status).toBe(200);
      const shift = closed.json.shift as Shift;
      expect(shift).toMatchObject({ status: "CLOSED", note: "Busy evening" });
      expect(line(shift, "CASH")).toMatchObject({ expected: 2_100, counted: 2_050, difference: -50, reason: "Change given short", expectedAtCount: null });
      expect(line(shift, "CARD")).toMatchObject({ expected: 3_000, counted: 3_000, difference: 0 });
      expect(await db.auditLog.count({ where: { tenantId: a, action: "cash.shift.close", entityId: shiftId } })).toBe(1);

      const twice = await close(shiftId, { counts: [{ method: "CASH", counted: 2_050, reason: "x" }, { method: "CARD", counted: 3_000 }] });
      expect(twice.res.status).toBe(409);
      expect(twice.json.error).toBe("invalid_state");
      expect((await pay({ amount: 100 })).json.error).toBe("no_shift");
      expect((await mine(receptionCookie)).json.shift).toBeNull();

      // The database keeps a closed shift as it was counted, and every shift.
      await expect(db.cashShift.update({ where: { id: shiftId }, data: { note: "changed" } })).rejects.toThrow(/closed shift is never changed/);
      await expect(db.cashShift.delete({ where: { id: shiftId } })).rejects.toThrow(/never deleted/);
    });

    it("shows a payment voided after the count against what was expected at the count", async () => {
      expect((await voidIt(cashPayment)).res.status).toBe(200);
      const today = await day();
      const shift = (today.json.shifts as Shift[]).find((s) => s.id === shiftId)!;
      expect(line(shift, "CASH")).toMatchObject({ expected: 900, counted: 2_050, difference: 1_150, expectedAtCount: 2_100 });
    });
  });

  describe("the day and its sign-off", () => {
    it("gives the front desk and the owner a branch's day: the shifts, the money outside them, the totals", async () => {
      const today = await day();
      expect(today.res.status).toBe(200);
      expect(today.json).toMatchObject({ date: dayKey(0), today: dayKey(0), clinic: { id: branch }, signedOff: null, canSignOff: false });
      expect((today.json.shifts as Shift[]).map((s) => [s.cashier.fullName, s.status])).toEqual([
        ["Desk A", "CLOSED"],
        ["Desk B", "OPEN"],
      ]);
      // Desk B's drawer is still open: the day is counted once every shift is closed.
      expect(today.json.totals).toEqual([
        expect.objectContaining({ method: "CASH", expected: 900 + 100, counted: null, difference: null }),
        expect.objectContaining({ method: "CARD", expected: 3_000, counted: null, difference: null }),
      ]);
      expect((await day({}, receptionCookie)).res.status).toBe(200);
      expect((await day({}, nurseCookie)).res.status).toBe(200);
      expect((await day({}, assistantCookie)).res.status).toBe(403);
      expect((await day({}, doctorCookie)).res.status).toBe(403);
      expect((await day({ date: "2026-02-30" })).res.status).toBe(422);

      const entered = await day({ date: dayKey(2) });
      expect(entered.json.shifts).toEqual([]);
      expect(entered.json.outside).toEqual({ count: 1, methods: [expect.objectContaining({ method: "CASH", amount: 250 })] });
      expect(entered.json.totals).toEqual([expect.objectContaining({ method: "CASH", expected: 250, counted: 250, difference: 0 })]);
      expect(entered.json.canSignOff).toBe(true);
    });

    it("signs a day off once every shift of it is closed; from then on the day is locked", async () => {
      // Three days ago: Desk C's shift, still open, and money entered late.
      const old = await db.cashShift.create({ data: { tenantId: a, clinicId: branch, userId: deskCId, openingFloat: 300, openedAt: onDay(3, 9) } });
      const late = await pay({ amount: 700, paidAt: onDay(3, 11).toISOString() }, ownerCookie);
      expect(late.res.status).toBe(201);

      expect((await signOff({ date: dayKey(3) }, receptionCookie)).res.status).toBe(403);
      const openShift = await signOff({ date: dayKey(3) });
      expect(openShift.res.status).toBe(409);
      expect(openShift.json.error).toBe("shifts_open");
      expect(openShift.json.message).toContain("Desk C");
      // The owner closes anyone's shift.
      expect((await close(old.id, { counts: [{ method: "CASH", counted: 300 }] }, ownerCookie)).res.status).toBe(200);

      const signed = await signOff({ date: dayKey(3), note: "All counted" });
      expect(signed.res.status).toBe(200);
      expect(signed.json).toMatchObject({ date: dayKey(3), canSignOff: false, signedOff: { by: "Owner A", note: "All counted" } });
      const record = await db.dayClose.findFirstOrThrow({ where: { tenantId: a, clinicId: branch, day: dayKey(3) } });
      expect(record.totals).toMatchObject({ shifts: 1, outside: 1, methods: [expect.objectContaining({ method: "CASH", expected: 1_000, counted: 1_000, difference: 0 })] });
      expect(await db.auditLog.count({ where: { tenantId: a, action: "cash.day.sign_off", entityId: branch } })).toBe(1);
      expect((await signOff({ date: dayKey(3) })).json.error).toBe("invalid_state");
      expect((await signOff({ date: dayKey(-1) })).json.error).toBe("invalid_state");

      // Locked: nothing more on it, nothing voided from it.
      const more = await pay({ amount: 100, paidAt: onDay(3, 15).toISOString() }, ownerCookie);
      expect(more.res.status).toBe(409);
      expect(more.json).toMatchObject({ error: "day_closed", day: dayKey(3) });
      const voided = await voidIt(late.json.payment.id);
      expect(voided.res.status).toBe(409);
      expect(voided.json.error).toBe("day_closed");
      expect(voided.json.message).toContain("record a refund instead");
      // The database refuses it too, whatever writes it.
      await expect(db.payment.create({ data: { tenantId: a, patientId: patient, clinicId: branch, kind: "PAYMENT", method: "CASH", amount: 50, paidAt: onDay(3, 16) } })).rejects.toThrow(/signed off/);
      await expect(db.payment.update({ where: { id: late.json.payment.id }, data: { note: "changed" } })).rejects.toThrow(/signed off/);
      await expect(db.dayClose.update({ where: { id: record.id }, data: { note: "changed" } })).rejects.toThrow(/never changed/);
      await expect(db.dayClose.delete({ where: { id: record.id } })).rejects.toThrow(/never changed/);
    });

    it("keeps imported money off a day signed off: flagged in the preview, refused at the confirm", async () => {
      const csv = ["date,phone,amount,kind,method,reference", `${dayKey(3)} 10:00,01001112299,450,payment,cash,IMP-1`, `${dayKey(4)} 10:00,01001112299,650,payment,cash,IMP-2`].join("\n");
      const preview = await importRoute(request("/api/payments/import", { method: "POST", cookie: receptionCookie, body: { csv } })).then(json);
      expect(preview.res.status).toBe(200);
      expect(preview.json.rows[0].problems).toContain("That day is signed off: it takes no more money");
      expect(preview.json.rows[1]).toMatchObject({ ok: true, amount: 650 });

      const row = (n: number, reference: string, amount: number) => ({ patientId: patient, paidAt: onDay(n, 10).toISOString(), amount, kind: "PAYMENT", method: "CASH", reference });
      const refused = await confirmRoute(request("/api/payments/import/confirm", { method: "POST", cookie: receptionCookie, body: { rows: [row(3, "IMP-1", 450), row(4, "IMP-2", 650)] } })).then(json);
      expect(refused.res.status).toBe(409);
      expect(refused.json).toMatchObject({ error: "day_closed", days: [dayKey(3)] });
      expect(await db.payment.count({ where: { tenantId: a, reference: { in: ["IMP-1", "IMP-2"] } } })).toBe(0);

      const taken = await confirmRoute(request("/api/payments/import/confirm", { method: "POST", cookie: receptionCookie, body: { rows: [row(4, "IMP-2", 650)] } })).then(json);
      expect(taken.res.status).toBe(201);
      expect(await db.payment.findFirstOrThrow({ where: { tenantId: a, reference: "IMP-2" } })).toMatchObject({ shiftId: null, clinicId: branch });
    });

    it("signs each branch's day off on its own", async () => {
      expect((await signOff({ date: dayKey(0), clinicId: branch2 })).res.status).toBe(200);
      const closedThere = await open({ openingFloat: 0, clinicId: branch2 }, deskCCookie);
      expect(closedThere.res.status).toBe(409);
      expect(closedThere.json.error).toBe("day_closed");
      const here = await open({ openingFloat: 0, clinicId: branch }, deskCCookie);
      expect(here.res.status).toBe(201);
      expect(here.json.shift.clinicId).toBe(branch);
      expect((await day({ clinicId: branch2 })).json.signedOff).not.toBeNull();
      expect((await day({ clinicId: branch })).json.signedOff).toBeNull();
    });
  });

  describe("a shift left open from an earlier day", () => {
    it("takes no more money: it is counted and closed, then today's is opened", async () => {
      const stale = await db.cashShift.create({ data: { tenantId: a, clinicId: branch, userId: nurseId, openingFloat: 200, openedAt: onDay(1, 9) } });
      const refused = await pay({ amount: 300 }, nurseCookie);
      expect(refused.res.status).toBe(409);
      expect(refused.json).toMatchObject({ error: "stale_shift", day: dayKey(1) });
      expect(refused.json.message).toContain("close it");

      const today = await day();
      expect(today.json.stale).toEqual([expect.objectContaining({ id: stale.id, cashier: "Nurse A" })]);
      const yesterday = await day({ date: dayKey(1) });
      expect(yesterday.json.canSignOff).toBe(false);

      expect((await close(stale.id, { counts: [{ method: "CASH", counted: 200 }] }, nurseCookie)).res.status).toBe(200);
      const fresh = await open({ openingFloat: 150 }, nurseCookie);
      expect(fresh.res.status).toBe(201);
      const paid = await pay({ amount: 300 }, nurseCookie);
      expect(paid.res.status).toBe(201);
      expect((await db.payment.findUniqueOrThrow({ where: { id: paid.json.payment.id } })).shiftId).toBe(fresh.json.shift.id);
      expect((await day()).json.stale).toEqual([]);
    });
  });

  describe("tenant isolation", () => {
    it("keeps another clinic's shifts and days out of reach (404)", async () => {
      expect((await close(shiftId, { counts: [{ method: "CASH", counted: 0 }] }, ownerBCookie)).res.status).toBe(404);
      expect((await day({ clinicId: branch }, ownerBCookie)).res.status).toBe(404);
      expect((await signOff({ date: dayKey(5), clinicId: branch }, ownerBCookie)).res.status).toBe(404);
      expect((await open({ openingFloat: 0, clinicId: branch }, ownerBCookie)).res.status).toBe(404);
      expect((await mine(ownerBCookie)).json.shift).toBeNull();
      expect(await db.dayClose.count({ where: { tenantId: a, day: dayKey(5) } })).toBe(0);
    });
  });
});

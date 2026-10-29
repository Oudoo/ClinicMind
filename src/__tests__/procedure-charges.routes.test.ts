/**
 * Procedures to charges over the real route handlers and the test database:
 * work done at once is charged on its day when signed; a procedure charged
 * nothing carries its reason; work done in stages (a course) is started,
 * charged session by session and signed by its last session, or early with
 * the sessions left; cancelling keeps what a course was charged and reverses
 * a signed procedure; charges are never edited. The day's work not billed,
 * and a free visit charged nothing with the reason. RBAC and tenant
 * isolation on every endpoint.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enrol = vi.hoisted(() => vi.fn(async (_tenantId: string, procedureId: string) => ({ enrolmentId: `enr-${procedureId}`, protocolId: "prot-test", tasks: 7 })));
vi.mock("@/modules/concierge/service", () => ({ enrolOnSignedProcedure: enrol }));

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, fromDateKey } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { stageShare, stagesFor, summarizeCharges } from "@/modules/finance/charges";
import { POST as createProcedureRoute } from "@/app/api/procedures/route";
import { POST as signRoute } from "@/app/api/procedures/[id]/sign/route";
import { POST as cancelRoute } from "@/app/api/procedures/[id]/cancel/route";
import { POST as startRoute } from "@/app/api/procedures/[id]/start/route";
import { POST as stageRoute } from "@/app/api/procedures/[id]/stages/route";
import { POST as noChargeRoute } from "@/app/api/appointments/[id]/no-charge/route";
import { GET as unbilledRoute } from "@/app/api/finance/unbilled/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

// Setup and checks call the services directly; the routes enter their own request scope.
runAsSystem();

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const DAY = 86_400_000;
const MIN = 60_000;

describe("charges (pure)", () => {
  it("splits a price into whole-pound stage shares that add up to it", () => {
    expect([1, 2, 3, 4, 5, 6].map((k) => stageShare(36_000, 6, k))).toEqual([6_000, 6_000, 6_000, 6_000, 6_000, 6_000]);
    const odd = [1, 2, 3, 4, 5, 6].map((k) => stageShare(10_000, 6, k));
    expect(odd.reduce((s, x) => s + x, 0)).toBe(10_000);
    expect(Math.max(...odd) - Math.min(...odd)).toBeLessThanOrEqual(1);
    expect(stageShare(0, 3, 2)).toBe(0);
  });

  it("knows which work is done in stages", () => {
    expect(stagesFor({ unit: "PACKAGE", sessions: 6 }, 1)).toBe(6);
    expect(stagesFor({ unit: "SESSION", sessions: null }, 3)).toBe(3);
    expect(stagesFor({ unit: "UNIT", sessions: null }, 2_400)).toBe(1);
    expect(stagesFor({ unit: "AREA", sessions: null }, 2)).toBe(1);
    expect(stagesFor(null, 4)).toBe(1);
  });

  it("counts the stages done, not the reversals", () => {
    expect(summarizeCharges([{ amount: 6_000, stage: 1, reversalOfId: null }, { amount: 6_000, stage: 2, reversalOfId: null }, { amount: -6_000, stage: 2, reversalOfId: "x" }])).toEqual({ charged: 6_000, stagesDone: 2 });
  });
});

describe.skipIf(!dbTestsEnabled)("procedure charge routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let timezone: string;
  let doctor: { id: string };
  let ownerCookie: string;
  let doctorCookie: string;
  let nurseCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  let acne: string;
  let laser: string;
  let course: string;
  let session: string;
  let prpSession: string;
  let patient: string;
  let patient2: string;
  let patient3: string;
  let patientB: string;
  let procedureB: string;
  let appointmentB: string;

  const call = async (route: (req: Request, p: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, body: unknown, cookie: string) => {
    const res = await route(request(path, { method: "POST", cookie, body }), params(id));
    return { res, json: await res.json() };
  };
  const create = async (body: Record<string, unknown>, cookie = ownerCookie) => {
    const res = await createProcedureRoute(request("/api/procedures", { method: "POST", cookie, body }));
    return { res, json: await res.json() };
  };
  const sign = (id: string, cookie = doctorCookie) => call(signRoute, `/api/procedures/${id}/sign`, id, undefined, cookie);
  const start = (id: string, startedAt: string, cookie = receptionCookie) => call(startRoute, `/api/procedures/${id}/start`, id, { startedAt }, cookie);
  const stage = (id: string, performedAt: Date, cookie = doctorCookie, extra: Record<string, unknown> = {}) =>
    call(stageRoute, `/api/procedures/${id}/stages`, id, { performedAt: performedAt.toISOString(), ...extra }, cookie);
  const cancel = (id: string, reason: string, cookie: string) => call(cancelRoute, `/api/procedures/${id}/cancel`, id, { reason }, cookie);
  const unbilled = async (date: string | null, cookie = receptionCookie) => {
    const res = await unbilledRoute(request(`/api/finance/unbilled${date ? `?date=${date}` : ""}`, { cookie }));
    return { res, json: await res.json() };
  };
  const charges = (procedureId: string) => db.charge.findMany({ where: { procedureId }, orderBy: { createdAt: "asc" } });
  const dayKey = (offset: number) => dateKeyInTz(addDays(new Date(), offset, timezone), timezone);
  const at = (offset: number, hour: number) => new Date(fromDateKey(dayKey(offset), timezone)!.getTime() + hour * 3_600_000);

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `chg-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `chg-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    timezone = await getTenantTimezone(a);
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Mariam" });
    const nurse = await createUser({ tenantId: a, role: "NURSE", fullName: "Nurse Heba" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    ownerCookie = await sessionCookieFor(owner.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    receptionCookie = await sessionCookieFor(reception.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await ensureDefaultTreatments(a);
    await ensureDefaultTreatments(b);
    const treatment = async (tenantId: string, key: string) => (await db.treatment.findFirstOrThrow({ where: { tenantId, key } })).id;
    acne = await treatment(a, "acne");
    laser = await treatment(a, "laser-hair-removal");
    const prp = await treatment(a, "prp-hair");
    const since = new Date(Date.now() - 400 * DAY);
    const item = async (code: string, name: string, unit: "SESSION" | "PACKAGE", treatmentId: string, amount: number, extra: Record<string, unknown> = {}) =>
      (
        await db.priceItem.create({
          data: { tenantId: a, code, name, category: "laser", unit, treatmentId, ...extra, prices: { create: { tenantId: a, amount, effectiveFrom: since } } },
        })
      ).id;
    session = await item("LHR-BODY", "Laser hair removal, full body", "SESSION", laser, 7_200);
    course = await item("LHR-BODY-6", "Laser hair removal, full body course", "PACKAGE", laser, 36_000, { sessions: 6, sessionItemId: session });
    prpSession = await item("PRP-HAIR", "PRP for hair loss", "SESSION", prp, 1_800);
    patient = (await db.patient.create({ data: { tenantId: a, fullName: "Salma Fathy", phone: "+201001110001" } })).id;
    patient2 = (await db.patient.create({ data: { tenantId: a, fullName: "Karim Nabil", phone: "+201001110002" } })).id;
    patient3 = (await db.patient.create({ data: { tenantId: a, fullName: "Hala Zaki", phone: "+201001110003" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b, fullName: "Patient Of B", phone: "+201001110009" } })).id;
    const acneB = await treatment(b, "acne");
    procedureB = (await db.procedure.create({ data: { tenantId: b, patientId: patientB, treatmentId: acneB, performedAt: new Date(), price: 2_000, stages: 3 } })).id;
    appointmentB = (
      await db.appointment.create({ data: { tenantId: b, patientId: patientB, startsAt: at(-1, 10), endsAt: at(-1, 10.5), status: "COMPLETED", kind: "FOLLOW_UP" } })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  beforeEach(() => {
    enrol.mockClear();
  });

  it("charges work done at once on its day, when it is signed", async () => {
    const performedAt = at(-1, 11);
    const made = await create({ patientId: patient, treatmentId: acne, doctorId: doctor.id, performedAt: performedAt.toISOString(), price: 2_000, discount: 200, discountReason: "LOYALTY" });
    expect(made.res.status).toBe(201);
    expect(made.json.procedure).toMatchObject({ stages: 1, charged: 0, stagesDone: 0 });
    expect(await charges(made.json.procedure.id)).toHaveLength(0);
    const signed = await sign(made.json.procedure.id);
    expect(signed.res.status).toBe(200);
    expect(signed.json.procedure).toMatchObject({ status: "SIGNED", charged: 1_800 });
    const rows = await charges(made.json.procedure.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ amount: 1_800, stage: null, patientId: patient, doctorId: doctor.id, tenantId: a });
    expect(rows[0]!.chargedAt.toISOString()).toBe(performedAt.toISOString());
    expect(rows[0]!.description).toBe("Acne treatment");
    expect(enrol).toHaveBeenCalledTimes(1);
  });

  it("asks why a procedure is charged nothing, and keeps the reason on its charge", async () => {
    const base = { patientId: patient, treatmentId: acne, performedAt: at(-1, 12).toISOString(), price: 1_500, discount: 1_500, discountReason: "GOODWILL" };
    const missing = await create(base);
    expect(missing.res.status).toBe(422);
    expect(missing.json.issues.fieldErrors.zeroChargeReason).toBeDefined();
    const made = await create({ ...base, zeroChargeReason: "Touch-up after the first session" });
    expect(made.res.status).toBe(201);
    expect(made.json.procedure.zeroChargeReason).toBe("Touch-up after the first session");
    await sign(made.json.procedure.id);
    const [row] = await charges(made.json.procedure.id);
    expect(row).toMatchObject({ amount: 0 });
    expect(row!.description).toBe("Acne treatment · no charge: Touch-up after the first session");
    // A reason without a free procedure is not kept.
    const paid = await create({ ...base, discount: 0, zeroChargeReason: "Not free at all" });
    expect(paid.json.procedure.zeroChargeReason).toBeNull();
  });

  it("starts a course, charges it session by session and signs it with the last session", async () => {
    const made = await create({ patientId: patient2, priceItemId: course, doctorId: doctor.id, performedAt: at(-2, 10).toISOString() });
    expect(made.res.status).toBe(201);
    const id = made.json.procedure.id as string;
    expect(made.json.procedure).toMatchObject({ stages: 6, price: 36_000, status: "PLANNED" });

    const early = await sign(id);
    expect(early.res.status).toBe(409);
    expect(early.json.error).toBe("not_started");
    expect((await stage(id, new Date())).json.error).toBe("invalid_state");

    expect((await start(id, dayKey(1))).res.status).toBe(422);
    expect((await start(id, dayKey(-2), assistantCookie)).res.status).toBe(403);
    const started = await start(id, dayKey(-2));
    expect(started.res.status).toBe(200);
    expect(started.json.procedure).toMatchObject({ status: "STARTED", stagesDone: 0, charged: 0 });
    expect((await start(id, dayKey(-2))).res.status).toBe(409);

    // Sessions are a clinician's to mark done.
    expect((await stage(id, at(-2, 11), receptionCookie)).res.status).toBe(403);
    expect((await stage(id, at(-2, 11), nurseCookie)).res.status).toBe(403);
    expect((await stage(id, at(-3, 11))).res.status).toBe(422);
    expect((await stage(id, new Date(Date.now() + 60 * MIN))).res.status).toBe(422);

    for (let k = 1; k <= 5; k++) {
      const done = await stage(id, new Date(Date.now() - (7 - k) * 10 * MIN));
      expect(done.res.status).toBe(200);
      expect(done.json).toMatchObject({ stage: k, of: 6, amount: 6_000 });
      expect(done.json.procedure).toMatchObject({ status: "STARTED", stagesDone: k, charged: 6_000 * k });
    }
    expect(enrol).not.toHaveBeenCalled();
    const last = await stage(id, new Date(Date.now() - 5 * MIN));
    expect(last.json).toMatchObject({ stage: 6, of: 6, amount: 6_000 });
    expect(last.json.procedure).toMatchObject({ status: "SIGNED", stagesDone: 6, charged: 36_000 });
    expect(enrol).toHaveBeenCalledTimes(1);
    const rows = await charges(id);
    expect(rows.map((r) => r.stage)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[1]!.description).toBe("Laser hair removal, full body course · session 2 of 6");
    expect((await stage(id, new Date())).res.status).toBe(409);

    const audits = await db.auditLog.findMany({ where: { tenantId: a, entityId: id }, select: { action: true } });
    expect(audits.filter((x) => x.action === "procedure.stage")).toHaveLength(6);
    expect(audits.some((x) => x.action === "procedure.start")).toBe(true);
    expect(audits.some((x) => x.action === "procedure.sign")).toBe(true);
  });

  it("treats so many sessions of a per-session item as a course, and charges the sessions left when signed early", async () => {
    const made = await create({ patientId: patient3, priceItemId: prpSession, quantity: 3, performedAt: at(-2, 9).toISOString(), price: 5_000 });
    const id = made.json.procedure.id as string;
    expect(made.json.procedure).toMatchObject({ stages: 3, price: 5_000 });
    await start(id, dayKey(-2));
    const one = await stage(id, at(-2, 10));
    expect(one.json.amount).toBe(stageShare(5_000, 3, 1));
    const signed = await sign(id);
    expect(signed.res.status).toBe(200);
    expect(signed.json.procedure).toMatchObject({ status: "SIGNED", charged: 5_000, stagesDone: 1 });
    const rows = await charges(id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ stage: null, amount: 5_000 - stageShare(5_000, 3, 1) });
    expect(rows[1]!.description).toBe("PRP for hair loss · sessions 2–3 of 3");
  });

  it("keeps what a cancelled course was charged, and reverses a signed procedure cancelled by a clinician", async () => {
    const made = await create({ patientId: patient2, priceItemId: course, performedAt: at(-2, 10).toISOString() });
    const id = made.json.procedure.id as string;
    await start(id, dayKey(-2));
    await stage(id, at(-2, 11));
    const cancelled = await cancel(id, "Moved abroad", receptionCookie);
    expect(cancelled.res.status).toBe(200);
    expect(cancelled.json.procedure).toMatchObject({ status: "CANCELLED", charged: 6_000 });

    const single = await create({ patientId: patient2, treatmentId: acne, performedAt: at(-1, 9).toISOString(), price: 2_200 });
    await sign(single.json.procedure.id);
    expect((await cancel(single.json.procedure.id, "Signed by mistake", receptionCookie)).res.status).toBe(409);
    const reversed = await cancel(single.json.procedure.id, "Signed by mistake", doctorCookie);
    expect(reversed.res.status).toBe(200);
    expect(reversed.json.procedure).toMatchObject({ status: "CANCELLED", charged: 0 });
    const rows = await charges(single.json.procedure.id);
    expect(rows.map((r) => r.amount)).toEqual([2_200, -2_200]);
    expect(rows[1]!.reversalOfId).toBe(rows[0]!.id);
    expect(rows[1]!.description).toBe("Reversed: Acne treatment");
  });

  it("never lets a charge be edited or deleted", async () => {
    const row = await db.charge.findFirstOrThrow({ where: { tenantId: a } });
    await expect(db.charge.update({ where: { id: row.id }, data: { amount: row.amount + 1 } })).rejects.toThrow();
    await expect(db.charge.delete({ where: { id: row.id } })).rejects.toThrow();
    expect((await db.charge.findUniqueOrThrow({ where: { id: row.id } })).amount).toBe(row.amount);
  });

  it("keeps another clinic's procedures and visits out of reach (404)", async () => {
    expect((await start(procedureB, dayKey(0), ownerCookie)).res.status).toBe(404);
    expect((await stage(procedureB, new Date(), ownerCookie)).res.status).toBe(404);
    expect((await call(noChargeRoute, `/api/appointments/${appointmentB}/no-charge`, appointmentB, { reason: "Free review" }, ownerCookie)).res.status).toBe(404);
    // …and their own owner sees only their own day.
    const theirs = await unbilled(dayKey(-1), ownerBCookie);
    expect(theirs.json.visits.map((v: { appointmentId: string }) => v.appointmentId)).toEqual([appointmentB]);
  });

  describe("the day's work not billed", () => {
    let visit: string;
    let free: string;
    let laserConsult: string;
    let courseVisit: string;
    let waiting: string;
    const yesterday = () => dayKey(-1);

    beforeAll(async () => {
      const appointment = (patientId: string, hour: number, kind: "FOLLOW_UP" | "CONSULTATION" | "PROCEDURE", extra: Record<string, unknown> = {}) =>
        db.appointment.create({ data: { tenantId: a, patientId, doctorId: doctor.id, startsAt: at(-1, hour), endsAt: at(-1, hour + 0.5), status: "COMPLETED", kind, ...extra } }).then((x) => x.id);
      const p4 = (await db.patient.create({ data: { tenantId: a, fullName: "Nour Samir", phone: "+201001110004" } })).id;
      const p5 = (await db.patient.create({ data: { tenantId: a, fullName: "Omar Lotfy", phone: "+201001110005" } })).id;
      const p6 = (await db.patient.create({ data: { tenantId: a, fullName: "Reem Kamel", phone: "+201001110006" } })).id;
      const p7 = (await db.patient.create({ data: { tenantId: a, fullName: "Ziad Hamdy", phone: "+201001110007" } })).id;
      visit = await appointment(p4, 13, "PROCEDURE");
      free = await appointment(p5, 14, "FOLLOW_UP");
      laserConsult = await appointment(p6, 15, "CONSULTATION", { treatmentId: laser });
      // A course under way: the visit was probably its next session.
      const c = await create({ patientId: p7, priceItemId: course, performedAt: at(-3, 10).toISOString() });
      await start(c.json.procedure.id, dayKey(-3));
      courseVisit = await appointment(p7, 16, "FOLLOW_UP");
      // Done at once yesterday, not signed.
      waiting = (await create({ patientId: p6, treatmentId: acne, performedAt: at(-1, 17).toISOString(), price: 1_600 })).json.procedure.id;
    });

    it("lists yesterday's visits with nothing billed, and the work waiting to be signed", async () => {
      const { res, json } = await unbilled(yesterday());
      expect(res.status).toBe(200);
      expect(json.date).toBe(yesterday());
      const ids = json.visits.map((v: { appointmentId: string }) => v.appointmentId);
      expect(ids).toEqual(expect.arrayContaining([visit, free, courseVisit]));
      // A consultation the catalogue makes free (laser) has nothing to bill.
      expect(ids).not.toContain(laserConsult);
      const withCourse = json.visits.find((v: { appointmentId: string }) => v.appointmentId === courseVisit);
      expect(withCourse.course).toMatchObject({ label: "Laser hair removal, full body course", nextStage: 1, stages: 6 });
      expect(json.procedures.map((p: { procedureId: string }) => p.procedureId)).toContain(waiting);
      expect(json.procedures.find((p: { procedureId: string }) => p.procedureId === waiting)).toMatchObject({ waitingFor: "signature", net: 1_600, patientName: "Reem Kamel" });
    });

    it("drops a visit once anything is billed for that patient that day", async () => {
      const p = (await db.appointment.findUniqueOrThrow({ where: { id: visit } })).patientId;
      await create({ patientId: p, treatmentId: acne, performedAt: at(-1, 13).toISOString(), price: 1_800 });
      const { json } = await unbilled(yesterday());
      expect(json.visits.map((v: { appointmentId: string }) => v.appointmentId)).not.toContain(visit);
      // A session marked done at that visit bills it too.
      const courseRow = await db.procedure.findFirstOrThrow({ where: { tenantId: a, status: "STARTED", patient: { fullName: "Ziad Hamdy" } } });
      await stage(courseRow.id, at(-1, 16), doctorCookie, { appointmentId: courseVisit });
      expect((await unbilled(yesterday())).json.visits.map((v: { appointmentId: string }) => v.appointmentId)).not.toContain(courseVisit);
    });

    it("charges a free visit nothing, with the reason, once", async () => {
      const path = `/api/appointments/${free}/no-charge`;
      expect((await call(noChargeRoute, path, free, { reason: "Free review" }, doctorCookie)).res.status).toBe(403);
      expect((await call(noChargeRoute, path, free, { reason: "" }, receptionCookie)).res.status).toBe(422);
      const made = await call(noChargeRoute, path, free, { reason: "Free review within two weeks" }, receptionCookie);
      expect(made.res.status).toBe(201);
      expect(made.json.charge).toMatchObject({ amount: 0, description: "Follow-up · no charge: Free review within two weeks" });
      expect((await call(noChargeRoute, path, free, { reason: "Again" }, receptionCookie)).json.error).toBe("already_billed");
      expect((await unbilled(yesterday())).json.visits.map((v: { appointmentId: string }) => v.appointmentId)).not.toContain(free);
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "appointment.no_charge", entityId: free } });
      expect(audit).not.toBeNull();
      // Only a visit that took place.
      const booked = await db.appointment.create({ data: { tenantId: a, patientId: patient, startsAt: at(1, 10), endsAt: at(1, 10.5), status: "SCHEDULED", kind: "FOLLOW_UP" } });
      expect((await call(noChargeRoute, `/api/appointments/${booked.id}/no-charge`, booked.id, { reason: "Free review" }, receptionCookie)).json.error).toBe("not_done");
    });

    it("is for the front desk and the owner, today by default", async () => {
      const today = await unbilled(null, ownerCookie);
      expect(today.res.status).toBe(200);
      expect(today.json.date).toBe(dayKey(0));
      expect((await unbilled(null, doctorCookie)).res.status).toBe(403);
      expect((await unbilled(null, assistantCookie)).res.status).toBe(403);
      expect((await unbilled("2026-02-30")).res.status).toBe(422);
    });
  });
});

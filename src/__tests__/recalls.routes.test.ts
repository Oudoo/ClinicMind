/**
 * Recalls over the real route handlers and the test database: the clinic's
 * default rules and the owner's edits; recalls made without anyone typing
 * them (a signed transplant's four reviews, a course's next session after
 * each one, a one-at-a-time PRP course up to its third session, a diagnosis
 * rule's review that moves instead of doubling, a follow-up the doctor
 * stated, planned work not booked, a missed visit not rebooked, a patient
 * not seen for a year), never twice however often the hooks and the sweep
 * run; each recall following the patient's bookings (booked, reopened when
 * the visit is cancelled, done when the visit or the session is); the
 * worklist (who to contact today, most urgent first) and the record (calls,
 * messages, snoozes, declines with a reason, unreachable, notes, booking into
 * a slot); the log the database keeps; RBAC and tenant isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { addDays, dateKeyInTz, fromDateKey, startOfDayInTz, zonedParts } from "@/lib/time";
import { ensureDefaultTreatments } from "@/modules/treatments/service";
import { recallBand } from "@/modules/recalls/constants";
import { durationPhrase, sweepRecalls } from "@/modules/recalls/engine";
import { followUpDays } from "@/modules/recalls/followups";
import { GET as listRoute, POST as addRoute } from "@/app/api/recalls/route";
import { GET as getRoute } from "@/app/api/recalls/[id]/route";
import { POST as actionRoute } from "@/app/api/recalls/[id]/actions/route";
import { POST as bookRoute } from "@/app/api/recalls/[id]/book/route";
import { GET as rulesRoute, POST as newRuleRoute } from "@/app/api/recall-rules/route";
import { PATCH as editRuleRoute } from "@/app/api/recall-rules/[id]/route";
import { POST as createProcedureRoute } from "@/app/api/procedures/route";
import { POST as signProcedureRoute } from "@/app/api/procedures/[id]/sign/route";
import { POST as startProcedureRoute } from "@/app/api/procedures/[id]/start/route";
import { POST as stageRoute } from "@/app/api/procedures/[id]/stages/route";
import { POST as cancelProcedureRoute } from "@/app/api/procedures/[id]/cancel/route";
import { POST as createAppointmentRoute } from "@/app/api/appointments/route";
import { POST as transitionRoute } from "@/app/api/appointments/[id]/transition/route";
import { POST as signConsultationRoute } from "@/app/api/consultations/[id]/sign/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const DAY = 86_400_000;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const dayKey = (n: number) => dateKeyInTz(addDays(new Date(), n, TZ), TZ);
/** Noon (clinic clock) `n` days from today: negative is the past. */
const onDay = (n: number, hour = 12) => new Date(fromDateKey(dayKey(n), TZ)!.getTime() + hour * 3_600_000);
/** The first day from `n` days ahead the clinic is open (not a Friday), at `hour`. */
const openDay = (n: number, hour = 12) => {
  for (let d = n; d < n + 7; d += 1) if (zonedParts(onDay(d), TZ).weekday !== 5) return onDay(d, hour);
  throw new Error("no open day");
};
const dueDay = (iso: string) => dateKeyInTz(new Date(iso), TZ);

interface Recall {
  id: string;
  kind: string;
  label: string;
  status: string;
  band: string;
  bandDays: number;
  dueAt: string;
  windowEndAt: string;
  value: number;
  stage: number | null;
  attempts: number;
  nextContactAt: string | null;
  declineReason: string | null;
  booked: { appointmentId: string; startsAt: string } | null;
  patient: { id: string; fullName: string };
  activities?: { kind: string; outcome: string | null; note: string | null; by: { name: string } | null }[];
}

describe.skipIf(!dbTestsEnabled)("recall routes", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let doctorId: string;
  let receptionId: string;
  let ownerCookie: string;
  let doctorCookie: string;
  let receptionCookie: string;
  let assistantCookie: string;
  let ownerBCookie: string;
  const treatment: Record<string, string> = {};
  let laserCourse: string;

  const json = async (res: Response) => ({ res, json: await res.json() });
  const list = (query: Record<string, string> = {}, cookie = receptionCookie) => listRoute(request(`/api/recalls?${new URLSearchParams(query).toString()}`, { cookie })).then(json);
  const get = (id: string, cookie = receptionCookie) => getRoute(request(`/api/recalls/${id}`, { cookie }), params(id)).then(json);
  const act = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => actionRoute(request(`/api/recalls/${id}/actions`, { method: "POST", cookie, body }), params(id)).then(json);
  const book = (id: string, body: Record<string, unknown>, cookie = receptionCookie) => bookRoute(request(`/api/recalls/${id}/book`, { method: "POST", cookie, body }), params(id)).then(json);
  const recallsOf = (patientId: string) => db.recall.findMany({ where: { tenantId: a, patientId }, orderBy: [{ dueAt: "asc" }, { createdAt: "asc" }] });
  const newPatient = async (name: string, extra: Record<string, unknown> = {}) => (await db.patient.create({ data: { tenantId: a, fullName: name, phone: "+201001234567", whatsapp: "+201001234567", ...extra } })).id;

  async function procedure(patientId: string, body: Record<string, unknown>) {
    const res = await createProcedureRoute(request("/api/procedures", { method: "POST", cookie: receptionCookie, body: { patientId, doctorId, ...body } }));
    const out = await res.json();
    expect(res.status, JSON.stringify(out)).toBe(201);
    return out.procedure.id as string;
  }
  const sign = async (id: string) => {
    const res = await signProcedureRoute(request(`/api/procedures/${id}/sign`, { method: "POST", cookie: doctorCookie, body: {} }), params(id));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };
  const stage = async (id: string, performedAt: Date) => {
    const res = await stageRoute(request(`/api/procedures/${id}/stages`, { method: "POST", cookie: doctorCookie, body: { performedAt: performedAt.toISOString() } }), params(id));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };
  async function bookVisit(patientId: string, startsAt: Date, kind = "FOLLOW_UP") {
    const res = await createAppointmentRoute(
      request("/api/appointments", { method: "POST", cookie: receptionCookie, body: { patientId, doctorId, kind, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString() } }),
    );
    const out = await res.json();
    expect(res.status, JSON.stringify(out)).toBe(201);
    return out.appointment.id as string;
  }
  const transition = async (id: string, status: string, reason?: string) => {
    const res = await transitionRoute(request(`/api/appointments/${id}/transition`, { method: "POST", cookie: receptionCookie, body: { status, ...(reason ? { reason } : {}) } }), params(id));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  };

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `recall-a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `recall-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    const owner = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Owner A" });
    const doctor = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Recall" });
    const reception = await createUser({ tenantId: a, role: "RECEPTIONIST", fullName: "Desk A" });
    const assistant = await createUser({ tenantId: a, role: "ASSISTANT", fullName: "Assistant A" });
    const ownerB = await createUser({ tenantId: b, role: "CLINIC_OWNER", fullName: "Owner B" });
    doctorId = doctor.id;
    receptionId = reception.id;
    ownerCookie = await sessionCookieFor(owner.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    receptionCookie = await sessionCookieFor(reception.id);
    assistantCookie = await sessionCookieFor(assistant.id);
    ownerBCookie = await sessionCookieFor(ownerB.id);
    await ensureDefaultTreatments(a);
    await ensureDefaultTreatments(b);
    for (const t of await db.treatment.findMany({ where: { tenantId: a } })) treatment[t.key] = t.id;
    laserCourse = (
      await db.priceItem.create({
        data: { tenantId: a, code: "LHR-6", name: "Laser — full legs, 6 sessions", category: "laser", unit: "PACKAGE", sessions: 6, treatmentId: treatment["laser-hair-removal"]!, prices: { create: { tenantId: a, amount: 6_000, effectiveFrom: new Date(Date.now() - 400 * DAY) } } },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("rules", () => {
    it("every clinic starts with the plan's four rules; the owner edits them, reception only reads them", async () => {
      const { res, json: out } = await rulesRoute(request("/api/recall-rules", { cookie: receptionCookie })).then(json);
      expect(res.status).toBe(200);
      const byTreatment = Object.fromEntries(out.rules.map((r: { treatment: { id: string } }) => [r.treatment.id, r]));
      expect(byTreatment[treatment["laser-hair-removal"]!]).toMatchObject({ kind: "SESSIONS", dueDays: [28], windowDays: 14, sessions: 6, channel: "WHATSAPP", ownerRole: "RECEPTIONIST", active: true });
      expect(byTreatment[treatment["prp-hair"]!]).toMatchObject({ kind: "SESSIONS", dueDays: [30], windowDays: 7, sessions: 3 });
      expect(byTreatment[treatment["hair-transplant"]!]).toMatchObject({ kind: "REVIEWS", dueDays: [30, 91, 182, 365], windowDays: 14 });
      expect(byTreatment[treatment.acne!]).toMatchObject({ kind: "REVIEWS", dueDays: [42], windowDays: 14, diagnosisTerms: ["acne", "حب الشباب"] });
      expect(out.rules).toHaveLength(4);
      // A second read does not make them again.
      expect((await rulesRoute(request("/api/recall-rules", { cookie: ownerCookie })).then(json)).json.rules).toHaveLength(4);

      const denied = await newRuleRoute(request("/api/recall-rules", { method: "POST", cookie: receptionCookie, body: { name: "x", kind: "REVIEWS", treatmentId: treatment.pigmentation, dueDays: [30] } }));
      expect(denied.status).toBe(403);
      const twoIntervals = await newRuleRoute(request("/api/recall-rules", { method: "POST", cookie: ownerCookie, body: { name: "Course", kind: "SESSIONS", treatmentId: treatment.pigmentation, dueDays: [21, 28] } })).then(json);
      expect(twoIntervals.res.status).toBe(422);
      const noTrigger = await newRuleRoute(request("/api/recall-rules", { method: "POST", cookie: ownerCookie, body: { name: "Reviews", kind: "REVIEWS", dueDays: [30] } })).then(json);
      expect(noTrigger.res.status).toBe(422);
      const made = await newRuleRoute(
        request("/api/recall-rules", { method: "POST", cookie: ownerCookie, body: { name: "Pigmentation review", kind: "REVIEWS", treatmentId: treatment.pigmentation, dueDays: [56, 28], windowDays: 7, channel: "VOICE" } }),
      ).then(json);
      expect(made.res.status).toBe(201);
      expect(made.json.rule).toMatchObject({ dueDays: [28, 56], channel: "VOICE", openRecalls: 0 });

      const edited = await editRuleRoute(request(`/api/recall-rules/${made.json.rule.id}`, { method: "PATCH", cookie: ownerCookie, body: { windowDays: 10, active: false } }), params(made.json.rule.id)).then(json);
      expect(edited.res.status).toBe(200);
      expect(edited.json.rule).toMatchObject({ windowDays: 10, active: false, dueDays: [28, 56] });
      const broken = await editRuleRoute(request(`/api/recall-rules/${made.json.rule.id}`, { method: "PATCH", cookie: ownerCookie, body: { kind: "SESSIONS" } }), params(made.json.rule.id));
      expect(broken.status).toBe(422);
      const foreign = await editRuleRoute(request(`/api/recall-rules/${made.json.rule.id}`, { method: "PATCH", cookie: ownerBCookie, body: { windowDays: 3 } }), params(made.json.rule.id));
      expect(foreign.status).toBe(404);
      expect(await db.auditLog.count({ where: { tenantId: a, action: { in: ["recall.rule.create", "recall.rule.update"] } } })).toBe(2);
    });
  });

  describe("made without anyone typing them", () => {
    it("a signed hair transplant brings its four reviews, once", async () => {
      const patient = await newPatient("Transplant Patient");
      const id = await procedure(patient, { treatmentId: treatment["hair-transplant"], performedAt: onDay(-2).toISOString(), price: 60_000 });
      await sign(id);
      let recalls = await recallsOf(patient);
      expect(recalls.map((r) => [r.kind, r.label, dueDay(r.dueAt.toISOString())])).toEqual([
        ["REVIEW", "Hair transplant · 1-month review", dayKey(28)],
        ["REVIEW", "Hair transplant · 3-month review", dayKey(89)],
        ["REVIEW", "Hair transplant · 6-month review", dayKey(180)],
        ["REVIEW", "Hair transplant · 12-month review", dayKey(363)],
      ]);
      // On time until 14 days after the due day.
      expect(dateKeyInTz(recalls[0]!.windowEndAt, TZ)).toBe(dayKey(42));
      expect(recalls.every((r) => r.status === "OPEN" && r.procedureId === id && r.createdById === doctorId)).toBe(true);
      const log = await db.recallActivity.findFirst({ where: { recallId: recalls[0]!.id } });
      expect(log).toMatchObject({ kind: "STATUS", outcome: "OPEN", byId: doctorId });
      expect(log?.note).toContain("the 1-month review");

      // The sweep and a repeated hook find nothing new.
      await sweepRecalls(new Date(), { tenantId: a });
      await sweepRecalls(new Date(), { tenantId: a });
      recalls = await recallsOf(patient);
      expect(recalls).toHaveLength(4);
    });

    it("a treatment done again moves its untouched review instead of making a second", async () => {
      const patient = await newPatient("Acne Course Patient");
      await sign(await procedure(patient, { treatmentId: treatment.acne, performedAt: onDay(-50).toISOString(), price: 1_500 }));
      expect((await recallsOf(patient)).map((r) => dueDay(r.dueAt.toISOString()))).toEqual([dayKey(-8)]);
      await sign(await procedure(patient, { treatmentId: treatment.acne, performedAt: onDay(-10).toISOString(), price: 1_500 }));
      const recalls = await recallsOf(patient);
      expect(recalls).toHaveLength(1);
      expect(dueDay(recalls[0]!.dueAt.toISOString())).toBe(dayKey(32));
      expect((await db.recallActivity.findFirst({ where: { recallId: recalls[0]!.id }, orderBy: { at: "desc" } }))?.note).toContain("done again");
      // Once the desk has worked it, the new one does not touch it either: still one.
      await db.recall.update({ where: { id: recalls[0]!.id }, data: { status: "CONTACTED", attempts: 1 } });
      await sign(await procedure(patient, { treatmentId: treatment.acne, performedAt: onDay(-2).toISOString(), price: 1_500 }));
      expect(await recallsOf(patient)).toHaveLength(1);
    });

    it("a course's next session follows each one; booked, cancelled, booked again, done when the session is", async () => {
      const patient = await newPatient("Laser Patient");
      const id = await procedure(patient, { priceItemId: laserCourse, performedAt: onDay(-30).toISOString() });
      const started = await startProcedureRoute(request(`/api/procedures/${id}/start`, { method: "POST", cookie: receptionCookie, body: { startedAt: dayKey(-30) } }), params(id));
      expect(started.status).toBe(200);
      await stage(id, onDay(-30, 11));
      let recalls = await recallsOf(patient);
      expect(recalls).toHaveLength(1);
      expect(recalls[0]).toMatchObject({ kind: "NEXT_SESSION", stage: 2, label: "Laser — full legs, 6 sessions · session 2 of 6", value: 1_000, status: "OPEN" });
      expect(dueDay(recalls[0]!.dueAt.toISOString())).toBe(dayKey(-2));
      expect(dateKeyInTz(recalls[0]!.windowEndAt, TZ)).toBe(dayKey(12));

      await stage(id, onDay(-1, 11));
      recalls = await recallsOf(patient);
      expect(recalls.map((r) => [r.stage, r.status])).toEqual([
        [2, "DONE"],
        [3, "OPEN"],
      ]);
      const session3 = recalls[1]!;
      expect(dueDay(session3.dueAt.toISOString())).toBe(dayKey(27));

      // A booking from two weeks before the due day books it, through the appointment route.
      const visit = await bookVisit(patient, openDay(20), "PROCEDURE");
      expect(await db.recall.findUniqueOrThrow({ where: { id: session3.id } })).toMatchObject({ status: "BOOKED", bookedAppointmentId: visit, bookedById: receptionId });
      await transition(visit, "CANCELLED", "Travelling");
      const reopened = await db.recall.findUniqueOrThrow({ where: { id: session3.id } });
      expect(reopened.status).toBe("OPEN");
      expect((await db.recallActivity.findFirst({ where: { recallId: session3.id }, orderBy: { at: "desc" } }))?.note).toContain("was cancelled");
      const again = await bookVisit(patient, openDay(22), "PROCEDURE");
      expect(await db.recall.findUniqueOrThrow({ where: { id: session3.id } })).toMatchObject({ status: "BOOKED", bookedAppointmentId: again });

      // Too early to be that session: a booking for tomorrow does not book session 3.
      const other = await newPatient("Early Booker");
      const early = await procedure(other, { priceItemId: laserCourse, performedAt: onDay(-3).toISOString() });
      await startProcedureRoute(request(`/api/procedures/${early}/start`, { method: "POST", cookie: receptionCookie, body: { startedAt: dayKey(-3) } }), params(early));
      await stage(early, onDay(-3, 11));
      await bookVisit(other, openDay(1));
      expect((await recallsOf(other))[0]).toMatchObject({ stage: 2, status: "OPEN" });

      // Cancelling the course ends what it brought the patient back for.
      const cancelled = await cancelProcedureRoute(request(`/api/procedures/${early}/cancel`, { method: "POST", cookie: doctorCookie, body: { reason: "Skin reaction" } }), params(early));
      expect(cancelled.status).toBe(200);
      expect((await recallsOf(other))[0]).toMatchObject({ status: "DECLINED", declineReason: "treatment_cancelled", outcomeNote: "Skin reaction" });
    });

    it("a follow-up the doctor stated becomes the course's session recall due within two weeks of it", async () => {
      const patient = await newPatient("Stated Follow-up Patient");
      const c = await db.consultation.create({
        data: { tenantId: a, patientId: patient, doctorId, status: "PENDING_REVIEW", transcript: "Doctor and patient talk about the next laser session.", extraction: { symptoms: [], diagnoses: [], medications: [], tests: [], followUps: ["Next session in 4 weeks"] }, summary: "Seen." },
      });
      expect((await signConsultationRoute(request(`/api/consultations/${c.id}/sign`, { method: "POST", cookie: doctorCookie, body: {} }), params(c.id))).status).toBe(200);
      expect((await recallsOf(patient)).map((r) => [r.kind, r.dedupeKey.split(":")[0]])).toEqual([["REVIEW", "followup"]]);
      const id = await procedure(patient, { priceItemId: laserCourse, performedAt: onDay(0, 0).toISOString() });
      await startProcedureRoute(request(`/api/procedures/${id}/start`, { method: "POST", cookie: receptionCookie, body: { startedAt: dayKey(0) } }), params(id));
      await stage(id, new Date(Date.now() - 60_000));
      const recalls = await recallsOf(patient);
      expect(recalls).toHaveLength(1);
      expect(recalls[0]).toMatchObject({ kind: "NEXT_SESSION", stage: 2, procedureId: id, dedupeKey: `session:${id}:2`, status: "OPEN" });
      expect((await db.recallActivity.findFirst({ where: { recallId: recalls[0]!.id }, orderBy: { at: "desc" } }))?.note).toContain("is this same return");
    });

    it("a course recorded one session at a time recalls up to its last session", async () => {
      const patient = await newPatient("PRP Patient");
      const first = await procedure(patient, { treatmentId: treatment["prp-hair"], performedAt: onDay(-60).toISOString(), price: 2_500 });
      await sign(first);
      let recalls = await recallsOf(patient);
      expect(recalls.map((r) => [r.kind, r.stage, r.label, r.value])).toEqual([["NEXT_SESSION", 2, "Hair loss / PRP · session 2 of 3", 2_500]]);
      expect(dueDay(recalls[0]!.dueAt.toISOString())).toBe(dayKey(-30));

      const second = await procedure(patient, { treatmentId: treatment["prp-hair"], performedAt: onDay(-29).toISOString(), price: 2_500 });
      await sign(second);
      recalls = await recallsOf(patient);
      expect(recalls.map((r) => [r.stage, r.status])).toEqual([
        [2, "DONE"],
        [3, "OPEN"],
      ]);
      const third = await procedure(patient, { treatmentId: treatment["prp-hair"], performedAt: new Date(Date.now() - 3_600_000).toISOString(), price: 2_500 });
      await sign(third);
      recalls = await recallsOf(patient);
      expect(recalls.map((r) => [r.stage, r.status])).toEqual([
        [2, "DONE"],
        [3, "DONE"],
      ]);
    });

    it("a diagnosis rule's review moves instead of doubling; a stated follow-up is its own recall unless it is the same return", async () => {
      const patient = await newPatient("Acne Patient");
      const consult = async (diagnoses: string[], followUps: string[]) => {
        const c = await db.consultation.create({
          data: { tenantId: a, patientId: patient, doctorId, status: "PENDING_REVIEW", transcript: "Doctor and patient talk about the skin for a while.", extraction: { symptoms: [], diagnoses, medications: [], tests: [], followUps }, summary: "Seen." },
        });
        const res = await signConsultationRoute(request(`/api/consultations/${c.id}/sign`, { method: "POST", cookie: doctorCookie, body: {} }), params(c.id));
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
        return c.id;
      };
      await consult(["Acne vulgaris"], ["Review in 6 weeks", "Repeat bloods in 3 months"]);
      let recalls = await recallsOf(patient);
      expect(recalls.map((r) => [r.kind, r.label, dueDay(r.dueAt.toISOString())])).toEqual([
        ["REVIEW", "Acne vulgaris · 6-week review", dayKey(42)],
        ["REVIEW", "Follow-up: Repeat bloods in 3 months", dayKey(90)],
      ]);
      await db.recall.updateMany({ where: { tenantId: a, patientId: patient, kind: "REVIEW", ruleId: { not: null } }, data: { dueAt: startOfDayInTz(onDay(30), TZ) } });
      await consult(["Acne"], []);
      recalls = await recallsOf(patient);
      expect(recalls).toHaveLength(2);
      const acne = recalls.find((r) => r.ruleId)!;
      expect(dueDay(acne.dueAt.toISOString())).toBe(dayKey(42));
      expect((await db.recallActivity.findFirst({ where: { recallId: acne.id }, orderBy: { at: "desc" } }))?.note).toContain("Seen again");
    });

    it("the sweep recalls planned work not booked, a missed visit not rebooked and a patient not seen for a year, once each", async () => {
      // Planned four days ago, nothing booked.
      const planned = await newPatient("Planned Patient");
      const plan = await procedure(planned, { treatmentId: treatment["botox-fillers"], performedAt: onDay(7).toISOString(), price: 4_000, discount: 0 });
      await db.procedure.update({ where: { id: plan }, data: { createdAt: onDay(-4) } });
      // A no-show three days ago, not rebooked; another one rebooked since.
      const missed = await newPatient("Missed Patient");
      const rebooked = await newPatient("Rebooked Patient");
      const visit = (patientId: string, at: Date, status: "NO_SHOW" | "COMPLETED" | "CANCELLED", changedAt = at) =>
        db.appointment.create({ data: { tenantId: a, patientId, doctorId, startsAt: at, endsAt: new Date(at.getTime() + 1_800_000), status, statusChangedAt: changedAt, kind: "CONSULTATION" }, select: { id: true } });
      const noShow = await visit(missed, onDay(-3), "NO_SHOW");
      await visit(rebooked, onDay(-3), "CANCELLED");
      await bookVisit(rebooked, openDay(5));
      // Last seen 13 months ago, nothing since; another seen 3 years ago (left to campaigns).
      const lapsed = await newPatient("Lapsed Patient");
      await visit(lapsed, new Date(Date.now() - 395 * DAY), "COMPLETED");
      const ancient = await newPatient("Ancient Patient");
      await visit(ancient, new Date(Date.now() - 3 * 365 * DAY), "COMPLETED");

      const first = await sweepRecalls(new Date(), { tenantId: a });
      expect(first.made.unbooked).toBeGreaterThanOrEqual(1);
      expect((await recallsOf(planned)).map((r) => [r.kind, r.value, r.procedureId])).toEqual([["UNBOOKED", 4_000, plan]]);
      expect((await recallsOf(missed)).map((r) => [r.kind, r.appointmentId, r.label])).toEqual([["MISSED", noShow.id, `Missed the consultation on ${new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" }).format(onDay(-3))}`]]);
      expect(await recallsOf(rebooked)).toEqual([]);
      expect((await recallsOf(lapsed)).map((r) => [r.kind, r.label.endsWith("(12 months)")])).toEqual([["LAPSED", true]]);
      expect(await recallsOf(ancient)).toEqual([]);

      await sweepRecalls(new Date(), { tenantId: a });
      expect(await db.recall.count({ where: { tenantId: a, patientId: { in: [planned, missed, lapsed] } } })).toBe(3);

      // Starting the planned work ends its recall; the lapsed patient coming back ends theirs.
      const started = await db.recall.findFirstOrThrow({ where: { tenantId: a, patientId: planned } });
      await db.procedure.update({ where: { id: plan }, data: { status: "SIGNED", signedAt: new Date() } });
      await sweepRecalls(new Date(), { tenantId: a });
      expect(await db.recall.findUniqueOrThrow({ where: { id: started.id } })).toMatchObject({ status: "DONE" });
      const visitId = await bookVisit(lapsed, openDay(3));
      expect((await recallsOf(lapsed))[0]).toMatchObject({ status: "BOOKED", bookedAppointmentId: visitId });
      await db.appointment.update({ where: { id: visitId }, data: { status: "COMPLETED", startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() - 1_800_000) } });
      await sweepRecalls(new Date(), { tenantId: a });
      expect((await recallsOf(lapsed))[0]).toMatchObject({ status: "DONE", doneAppointmentId: visitId });
    });
  });

  describe("the worklist and the record", () => {
    let overdue: string;
    let due: string;
    let soonCall: string;
    let soonMessage: string;
    let worthMore: string;

    beforeAll(async () => {
      const mk = async (name: string, dueIn: number, window: number, extra: Record<string, unknown> = {}, patientExtra: Record<string, unknown> = {}) => {
        const patientId = await newPatient(name, patientExtra);
        const dueAt = startOfDayInTz(onDay(dueIn), TZ);
        const r = await db.recall.create({
          data: { tenantId: a, patientId, kind: "REVIEW", label: `${name} review`, dueAt, windowEndAt: new Date(startOfDayInTz(onDay(dueIn + window), TZ).getTime() + DAY - 1), dedupeKey: `test:${name}`, ...extra },
        });
        return r.id;
      };
      overdue = await mk("Overdue Olivia", -20, 7, { value: 500 });
      due = await mk("Due Dina", -2, 14, { value: 0 });
      worthMore = await mk("Due Worth", -2, 14, { value: 9_000 });
      soonCall = await mk("Soon Call", 5, 14, { channel: "VOICE" });
      soonMessage = await mk("Soon Message", 5, 14);
    });

    it("today: due and overdue, most urgent first, plus the due-soon that no message reaches", async () => {
      const { res, json: out } = await list({ tab: "today", q: "" });
      expect(res.status).toBe(200);
      const mine = out.recalls.filter((r: Recall) => [overdue, due, worthMore, soonCall, soonMessage].includes(r.id));
      expect(mine.map((r: Recall) => r.id)).toEqual([overdue, worthMore, due, soonCall]);
      expect(mine[0]).toMatchObject({ band: "overdue", bandLabel: "Overdue 13 days" });
      expect(mine[3]).toMatchObject({ band: "soon", hint: "A phone-call recall: no automatic message goes." });
      const soon = await list({ tab: "soon" });
      expect(soon.json.recalls.map((r: Recall) => r.id)).toEqual(expect.arrayContaining([soonCall, soonMessage]));
      expect(out.counts.today).toBeGreaterThanOrEqual(4);
    });

    it("calls, messages, snoozes, declines, unreachable, notes: logged, audited and moving the recall", async () => {
      // No answer: tried again in two days, off today's list.
      let r = await act(due, { action: "call", outcome: "no_answer", note: "Rang twice" });
      expect(r.res.status).toBe(200);
      expect(r.json.recall).toMatchObject({ status: "CONTACTED", attempts: 1 });
      expect(dueDay(r.json.recall.nextContactAt)).toBe(dayKey(2));
      expect((await list({ tab: "today" })).json.recalls.map((x: Recall) => x.id)).not.toContain(due);

      expect((await act(due, { action: "call", outcome: "call_back" })).res.status).toBe(422);
      r = await act(due, { action: "call", outcome: "call_back", callBackOn: dayKey(4) });
      expect(dueDay(r.json.recall.nextContactAt)).toBe(dayKey(4));
      expect((await act(due, { action: "call", outcome: "declined" })).res.status).toBe(422);
      expect((await act(due, { action: "decline", reason: "other" })).res.status).toBe(422);

      // The WhatsApp template, in the patient's language (no channel connected: logged on the conversation).
      r = await act(overdue, { action: "message" });
      expect(r.res.status).toBe(200);
      expect(r.json.message.delivery).toBe("LOGGED");
      expect(r.json.recall).toMatchObject({ status: "CONTACTED", attempts: 1 });
      const sent = await db.message.findFirstOrThrow({ where: { tenantId: a, conversationId: r.json.message.conversationId }, orderBy: { createdAt: "desc" } });
      expect(sent.templateKey).toBe("recall-review-ar");
      expect(sent.body).toContain("أهلاً Overdue");
      expect(sent.body).not.toContain("{{");

      // Snoozed until a day ahead; declined with a reason; reopened; unreachable; a note on a closed one.
      expect((await act(soonMessage, { action: "snooze", until: dayKey(0) })).res.status).toBe(422);
      r = await act(soonMessage, { action: "snooze", until: dayKey(10), note: "After the holiday" });
      expect(r.json.recall).toMatchObject({ status: "SNOOZED", band: "snoozed" });
      r = await act(due, { action: "decline", reason: "price", note: "Too expensive this month" });
      expect(r.json.recall).toMatchObject({ status: "DECLINED", declineReason: "price", declineLabel: "Price" });
      expect((await act(due, { action: "call", outcome: "no_answer" })).res.status).toBe(409);
      r = await act(due, { action: "reopen", note: "Changed her mind" });
      expect(r.json.recall.status).toBe("OPEN");
      r = await act(due, { action: "unreachable", note: "Number switched off" });
      expect(r.json.recall.status).toBe("UNREACHABLE");
      r = await act(due, { action: "note", note: "Try her sister's number" });
      expect(r.res.status).toBe(200);

      const detail = await get(due);
      expect(detail.json.recall.activities.map((x: { kind: string; outcome: string | null }) => [x.kind, x.outcome])).toEqual([
        ["CALL", "no_answer"],
        ["CALL", "call_back"],
        ["STATUS", "DECLINED"],
        ["STATUS", "OPEN"],
        ["STATUS", "UNREACHABLE"],
        ["NOTE", null],
      ]);
      expect(detail.json.recall.activities[0]).toMatchObject({ note: "Rang twice", outcomeLabel: "No answer", by: { name: "Desk A" } });
      expect(await db.auditLog.count({ where: { tenantId: a, entity: "Recall", entityId: due } })).toBe(6);
    });

    it("books straight into a free slot; the slot rules hold", async () => {
      const start = openDay(3, 11);
      const r = await book(worthMore, { doctorId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 30 * 60_000).toISOString() });
      expect(r.res.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json.recall).toMatchObject({ status: "BOOKED", booked: { appointmentId: r.json.appointment.id } });
      expect(r.json.appointment).toMatchObject({ kind: "FOLLOW_UP", reason: "Due Worth review", status: "SCHEDULED" });
      expect((await book(worthMore, { doctorId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 30 * 60_000).toISOString() })).res.status).toBe(409);
      // The same slot for someone else: taken.
      const clash = await book(overdue, { doctorId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 30 * 60_000).toISOString() });
      expect(clash.res.status).toBe(409);
      expect(clash.json.error).toBe("conflict");
      expect((await list({ tab: "booked" })).json.recalls.map((x: Recall) => x.id)).toContain(worthMore);
    });

    it("adds a recall by hand", async () => {
      const patientId = await newPatient("Manual Patient");
      const { res, json: out } = await addRoute(request("/api/recalls", { method: "POST", cookie: doctorCookie, body: { patientId, label: "Check the scar", dueOn: dayKey(21), windowDays: 5, note: "After the exams" } })).then(json);
      expect(res.status).toBe(201);
      expect(out.recall).toMatchObject({ kind: "REVIEW", label: "Check the scar", status: "OPEN", band: "upcoming" });
      expect(dueDay(out.recall.dueAt)).toBe(dayKey(21));
      expect(out.recall.lastActivity.note).toBe("Added by Dr. Recall: After the exams");
      expect((await addRoute(request("/api/recalls", { method: "POST", cookie: doctorCookie, body: { patientId, label: "x", dueOn: dayKey(-1) } }))).status).toBe(422);
    });
  });

  describe("access and the record the database keeps", () => {
    it("the assistant reads but does not work recalls; another clinic sees none of them", async () => {
      const anyRecall = await db.recall.findFirstOrThrow({ where: { tenantId: a, status: "OPEN" } });
      expect((await list({}, assistantCookie)).res.status).toBe(200);
      expect((await act(anyRecall.id, { action: "note", note: "x" }, assistantCookie)).res.status).toBe(403);
      expect((await get(anyRecall.id, ownerBCookie)).res.status).toBe(404);
      expect((await act(anyRecall.id, { action: "note", note: "x" }, ownerBCookie)).res.status).toBe(404);
      const other = await list({ tab: "all" }, ownerBCookie);
      expect(other.json.recalls).toEqual([]);
    });

    it("a recall is never deleted and its log never changes", async () => {
      const r = await db.recall.findFirstOrThrow({ where: { tenantId: a, status: "OPEN" } });
      await expect(db.recall.delete({ where: { id: r.id } })).rejects.toThrow(/never deleted/);
      const activity = await db.recallActivity.findFirstOrThrow({ where: { tenantId: a } });
      await expect(db.recallActivity.update({ where: { id: activity.id }, data: { note: "rewritten" } })).rejects.toThrow(/never edited/);
      await expect(db.recallActivity.delete({ where: { id: activity.id } })).rejects.toThrow(/never edited/);
      // A closed recall must say when; a declined one why.
      await expect(db.recall.update({ where: { id: r.id }, data: { status: "DONE" } })).rejects.toThrow();
    });
  });

  describe("the words", () => {
    it("bands, phrases and stated follow-ups", () => {
      const today = startOfDayInTz(new Date(), TZ);
      const at = (n: number) => startOfDayInTz(onDay(n), TZ);
      expect(recallBand({ status: "OPEN", dueAt: at(20), windowEndAt: at(30) }, today)).toEqual({ band: "upcoming", days: 20 });
      expect(recallBand({ status: "OPEN", dueAt: at(3), windowEndAt: at(10) }, today)).toEqual({ band: "soon", days: 3 });
      expect(recallBand({ status: "CONTACTED", dueAt: at(-2), windowEndAt: at(5) }, today)).toEqual({ band: "due", days: 2 });
      expect(recallBand({ status: "OPEN", dueAt: at(-10), windowEndAt: new Date(at(-4).getTime() + DAY - 1) }, today)).toEqual({ band: "overdue", days: 4 });
      expect(durationPhrase(30)).toBe("1-month");
      expect(durationPhrase(91)).toBe("3-month");
      expect(durationPhrase(365)).toBe("12-month");
      expect(durationPhrase(42)).toBe("6-week");
      expect(durationPhrase(10)).toBe("10-day");
      expect(followUpDays("Review in 6-8 weeks")).toBe(42);
      expect(followUpDays("متابعة بعد شهرين")).toBe(60);
      expect(followUpDays("Return if worse")).toBeNull();
      expect(followUpDays("Itchy for 2 weeks")).toBeNull();
    });
  });
});

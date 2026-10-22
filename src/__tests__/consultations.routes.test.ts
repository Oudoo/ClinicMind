/**
 * Consultation Intelligence against the test database: review-before-sign
 * with diagnosis de-duplication and medication reconciliation, discard,
 * list/get, tenant isolation, RBAC and the extraction parser.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GET as listConsultations } from "@/app/api/consultations/route";
import { GET as getConsultation } from "@/app/api/consultations/[id]/route";
import { POST as sign } from "@/app/api/consultations/[id]/sign/route";
import { POST as discard } from "@/app/api/consultations/[id]/discard/route";
import { POST as extract } from "@/app/api/consultations/extract/route";
import { GET as patientMedications } from "@/app/api/consultations/patient/[patientId]/medications/route";
import {
  MAX_EXTRACTION_ITEM_LENGTH,
  MAX_EXTRACTION_ITEMS,
  MAX_MEDICATION_FIELD_LENGTH,
  MAX_MEDICATION_NAME_LENGTH,
  normaliseExtraction,
  parseClinicalExtraction,
} from "@/lib/ai/extraction";
import { STOP_REASON_ON_SIGN } from "@/modules/consultations/service";
import { EXTRACTION_LIMITS } from "@/modules/consultations/types";
import {
  createTenant,
  createUser,
  dbTestsEnabled,
  deleteTenants,
  request,
  sessionCookieFor,
} from "@/test/db";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const patientParams = (patientId: string) => ({ params: Promise.resolve({ patientId }) });

const TRANSCRIPT = "Doctor: how have you been? Patient: tired, drinking a lot of water, up at night to pass urine.";

/** The AI draft seeded on consultations under test (the provider is `echo`, so it is never produced live). */
const DRAFT = {
  symptoms: ["Polyuria", "Fatigue"],
  diagnoses: ["hypertension", "Type 2 diabetes mellitus"],
  medications: [
    { name: "metformin", dosage: "1000 mg", frequency: "twice daily" },
    { name: "Atorvastatin", dosage: "20 mg", frequency: "at night" },
  ],
  tests: ["HbA1c"],
  followUps: ["Review in 3 months"],
};

describe.skipIf(!dbTestsEnabled)("consultations", () => {
  const created: string[] = [];
  let a: { id: string };
  let b: { id: string };
  let doctorA: { id: string };
  let nurseA: { id: string };
  let doctorCookie: string;
  let nurseCookie: string;
  let ownerCookie: string;
  let doctorBCookie: string;
  let patientA: string;
  let patientA2: string;
  let patientB: string;
  let metforminId: string;
  let aspirinId: string;
  let patientBMedicationId: string;
  let appointmentA: string;
  let appointmentA2: string;
  let appointmentB: string;

  async function seedConsultation(tenantId: string, patientId: string, doctorId: string, extraction: unknown = DRAFT) {
    return db.consultation.create({
      data: {
        tenantId,
        patientId,
        doctorId,
        status: "PENDING_REVIEW",
        transcript: TRANSCRIPT,
        extraction: extraction as never,
        summary: "AI summary.",
      },
    });
  }

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `ca-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `cb-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA;
    b = tenantB;

    doctorA = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr A" });
    nurseA = await createUser({ tenantId: a.id, role: "NURSE", fullName: "Nurse A" });
    const ownerA = await createUser({ tenantId: a.id, role: "CLINIC_OWNER" });
    const doctorB = await createUser({ tenantId: b.id, role: "DOCTOR" });
    doctorCookie = await sessionCookieFor(doctorA.id);
    nurseCookie = await sessionCookieFor(nurseA.id);
    ownerCookie = await sessionCookieFor(ownerA.id);
    doctorBCookie = await sessionCookieFor(doctorB.id);

    patientA = (
      await db.patient.create({
        data: {
          tenantId: a.id,
          fullName: "Alice A",
          medicalHistory: { create: { tenantId: a.id, diagnoses: ["Hypertension"] } },
        },
      })
    ).id;
    patientA2 = (await db.patient.create({ data: { tenantId: a.id, fullName: "Amir A" } })).id;
    patientB = (await db.patient.create({ data: { tenantId: b.id, fullName: "Bob B" } })).id;

    metforminId = (
      await db.medication.create({
        data: { tenantId: a.id, patientId: patientA, name: "Metformin", dosage: "500 mg", frequency: "once daily", active: true },
      })
    ).id;
    aspirinId = (
      await db.medication.create({
        data: { tenantId: a.id, patientId: patientA, name: "Aspirin", dosage: "75 mg", frequency: "daily", active: true },
      })
    ).id;
    await db.medication.create({
      data: { tenantId: a.id, patientId: patientA, name: "Old drug", active: false, stoppedAt: new Date(), stopReason: "historic" },
    });
    patientBMedicationId = (
      await db.medication.create({ data: { tenantId: b.id, patientId: patientB, name: "Ibuprofen", active: true } })
    ).id;

    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const later = new Date(soon.getTime() + 30 * 60 * 1000);
    appointmentA = (
      await db.appointment.create({ data: { tenantId: a.id, patientId: patientA, startsAt: soon, endsAt: later, reason: "Diabetes review" } })
    ).id;
    appointmentA2 = (
      await db.appointment.create({ data: { tenantId: a.id, patientId: patientA2, startsAt: soon, endsAt: later } })
    ).id;
    appointmentB = (
      await db.appointment.create({ data: { tenantId: b.id, patientId: patientB, startsAt: soon, endsAt: later } })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("sign", () => {
    let signedId: string;
    let visitId: string;

    it("writes the reviewed draft into the record: de-duplicated diagnoses, reconciled and stopped medications, completed appointment, audit and timeline", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      signedId = consultation.id;
      const extraction = {
        ...DRAFT,
        symptoms: ["  Polyuria ", "Fatigue"],
        // Same diagnosis twice in different spellings, on top of the one already in the history.
        diagnoses: ["hypertension", "Type 2 diabetes mellitus", "type 2  Diabetes Mellitus"],
      };
      const res = await sign(
        request(`/api/consultations/${consultation.id}/sign`, {
          cookie: doctorCookie,
          body: { summary: "Edited summary.", extraction, appointmentId: appointmentA, stopMedicationIds: [aspirinId] },
        }),
        idParams(consultation.id),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      visitId = json.visitId;
      expect(json).toMatchObject({
        ok: true,
        patientId: patientA,
        editedByClinician: true,
        addedDiagnoses: ["Type 2 diabetes mellitus"],
        appointmentId: appointmentA,
        medications: {
          started: ["Atorvastatin · 20 mg · at night"],
          adjusted: ["Metformin · 1000 mg · twice daily"],
          continued: [],
          stopped: ["Aspirin"],
        },
      });

      // Diagnoses: "hypertension" already there as "Hypertension"; the new one once.
      const history = await db.medicalHistory.findUnique({ where: { patientId: patientA } });
      expect(history?.diagnoses).toEqual(["Hypertension", "Type 2 diabetes mellitus"]);

      // Medications: reconciled, not duplicated; stops recorded.
      const medications = await db.medication.findMany({ where: { patientId: patientA }, orderBy: { name: "asc" } });
      const metformin = medications.filter((m) => m.name.toLowerCase() === "metformin");
      expect(metformin).toHaveLength(1);
      expect(metformin[0]).toMatchObject({ id: metforminId, active: true, dosage: "1000 mg", frequency: "twice daily", visitId });
      expect(medications.find((m) => m.name === "Atorvastatin")).toMatchObject({
        tenantId: a.id,
        active: true,
        dosage: "20 mg",
        frequency: "at night",
        visitId,
      });
      const aspirin = medications.find((m) => m.id === aspirinId);
      expect(aspirin).toMatchObject({ active: false, stopReason: STOP_REASON_ON_SIGN });
      expect(aspirin?.stoppedAt).toBeInstanceOf(Date);
      expect(medications.filter((m) => m.active).map((m) => m.name).sort()).toEqual(["Atorvastatin", "Metformin"]);

      // Visit, consultation and appointment.
      const visit = await db.visit.findUnique({ where: { id: visitId } });
      expect(visit).toMatchObject({ tenantId: a.id, patientId: patientA, doctorId: doctorA.id, appointmentId: appointmentA, summary: "Edited summary.", transcript: TRANSCRIPT });
      const updated = await db.consultation.findUnique({ where: { id: consultation.id } });
      expect(updated).toMatchObject({ status: "SIGNED", visitId, reviewedById: doctorA.id, summary: "Edited summary." });
      expect(updated?.reviewedAt).toBeInstanceOf(Date);
      expect((updated?.extraction as { symptoms: string[] }).symptoms).toEqual(["Polyuria", "Fatigue"]);
      const appointment = await db.appointment.findUnique({ where: { id: appointmentA } });
      expect(appointment?.status).toBe("COMPLETED");
      expect(appointment?.statusChangedAt).toBeInstanceOf(Date);

      // Timeline: the visit, the one new diagnosis, one prescription entry.
      const timeline = await db.timelineEvent.findMany({ where: { tenantId: a.id, patientId: patientA, refId: visitId } });
      expect(timeline.map((e) => e.kind).sort()).toEqual(["DIAGNOSIS", "PRESCRIPTION", "VISIT"]);
      expect(timeline.find((e) => e.kind === "DIAGNOSIS")?.title).toBe("Diagnosis — Type 2 diabetes mellitus");
      const prescription = timeline.find((e) => e.kind === "PRESCRIPTION")?.body ?? "";
      expect(prescription).toContain("Started: Atorvastatin · 20 mg · at night");
      expect(prescription).toContain("Adjusted: Metformin · 1000 mg · twice daily");
      expect(prescription).toContain("Stopped: Aspirin");

      // Audit: the AI draft next to what was signed.
      const auditRow = await db.auditLog.findFirst({ where: { tenantId: a.id, action: "consultation.sign", entityId: consultation.id } });
      expect(auditRow?.actorId).toBe(doctorA.id);
      expect(auditRow?.before).toEqual({ status: "PENDING_REVIEW", extraction: DRAFT, summary: "AI summary." });
      expect(auditRow?.after).toMatchObject({
        status: "SIGNED",
        visitId,
        editedByClinician: true,
        appointmentId: appointmentA,
        stopMedicationIds: [aspirinId],
        extraction: { ...extraction, symptoms: ["Polyuria", "Fatigue"] },
        addedDiagnoses: ["Type 2 diabetes mellitus"],
      });
    });

    it("cannot be signed twice", async () => {
      const before = await db.visit.count({ where: { patientId: patientA } });
      const res = await sign(request(`/api/consultations/${signedId}/sign`, { cookie: doctorCookie, body: {} }), idParams(signedId));
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "not_pending_review" });
      expect(await db.visit.count({ where: { patientId: patientA } })).toBe(before);
    });

    it("signing the untouched AI draft records editedByClinician=false and signs the stored draft", async () => {
      const consultation = await seedConsultation(a.id, patientA2, doctorA.id);
      const res = await sign(request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorCookie, body: {} }), idParams(consultation.id));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ editedByClinician: false, addedDiagnoses: DRAFT.diagnoses, appointmentId: null });
      expect(json.medications.started).toHaveLength(2);
      const history = await db.medicalHistory.findUnique({ where: { patientId: patientA2 } });
      expect(history?.diagnoses).toEqual(DRAFT.diagnoses);
      const auditRow = await db.auditLog.findFirst({ where: { action: "consultation.sign", entityId: consultation.id } });
      expect(auditRow?.after).toMatchObject({ editedByClinician: false });
      const timeline = await db.timelineEvent.findMany({ where: { patientId: patientA2 } });
      expect(timeline.map((e) => e.kind).sort()).toEqual(["DIAGNOSIS", "DIAGNOSIS", "PRESCRIPTION", "VISIT"]);
    });

    it("re-signing the same medications continues them without duplicating rows or emitting a prescription event", async () => {
      const consultation = await seedConsultation(a.id, patientA2, doctorA.id, { ...DRAFT, diagnoses: [] });
      const res = await sign(request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorCookie, body: {} }), idParams(consultation.id));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.medications).toMatchObject({ started: [], adjusted: [], stopped: [] });
      expect(json.medications.continued).toHaveLength(2);
      expect(await db.medication.count({ where: { patientId: patientA2, active: true } })).toBe(2);
      const events = await db.timelineEvent.findMany({ where: { refId: json.visitId } });
      expect(events.map((e) => e.kind)).toEqual(["VISIT"]);
    });

    it("refuses an appointment of another tenant or another patient with 404 and writes nothing", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      for (const appointmentId of [appointmentB, appointmentA2, "does-not-exist"]) {
        const res = await sign(
          request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorCookie, body: { appointmentId } }),
          idParams(consultation.id),
        );
        expect(res.status, appointmentId).toBe(404);
        await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "appointment" });
      }
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");
      expect(await db.visit.count({ where: { patientId: patientA } })).toBe(1);
      expect((await db.appointment.findUnique({ where: { id: appointmentA2 } }))?.status).toBe("SCHEDULED");
    });

    it("refuses to link an appointment that already has a signed visit", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const res = await sign(
        request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorCookie, body: { appointmentId: appointmentA } }),
        idParams(consultation.id),
      );
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toEqual({ error: "appointment_already_signed" });
    });

    it("refuses to stop a medication of another patient", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const res = await sign(
        request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorCookie, body: { stopMedicationIds: [patientBMedicationId] } }),
        idParams(consultation.id),
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "medication" });
      expect((await db.medication.findUnique({ where: { id: patientBMedicationId } }))?.active).toBe(true);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");
    });

    it("validates the reviewed extraction and rejects a body that is not JSON", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const tooLong = await sign(
        request(`/api/consultations/${consultation.id}/sign`, {
          cookie: doctorCookie,
          body: { extraction: { symptoms: ["x".repeat(MAX_EXTRACTION_ITEM_LENGTH + 1)] } },
        }),
        idParams(consultation.id),
      );
      expect(tooLong.status).toBe(422);
      expect((await tooLong.json()).error).toBe("validation_error");

      const notJson = await sign(request(`/api/consultations/${consultation.id}/sign`, { method: "POST", cookie: doctorCookie }), idParams(consultation.id));
      expect(notJson.status).toBe(400);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");
    });

    it("is for clinicians only: a nurse gets 403, the physician-owner may sign", async () => {
      // Own patient so the visit counts asserted by other tests stay untouched.
      const patient = (await db.patient.create({ data: { tenantId: a.id, fullName: "Owner Signs" } })).id;
      const consultation = await seedConsultation(a.id, patient, doctorA.id);
      const nurse = await sign(request(`/api/consultations/${consultation.id}/sign`, { cookie: nurseCookie, body: {} }), idParams(consultation.id));
      expect(nurse.status).toBe(403);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");

      const owner = await sign(request(`/api/consultations/${consultation.id}/sign`, { cookie: ownerCookie, body: {} }), idParams(consultation.id));
      expect(owner.status).toBe(200);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("SIGNED");
      expect(await db.visit.count({ where: { patientId: patient } })).toBe(1);
    });

    it("is a 404 for another tenant's doctor", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const res = await sign(request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorBCookie, body: {} }), idParams(consultation.id));
      expect(res.status).toBe(404);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");
    });

    it("rejects cross-origin browser requests", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const res = await sign(
        request(`/api/consultations/${consultation.id}/sign`, { cookie: doctorCookie, body: {}, headers: { origin: "https://evil.example" } }),
        idParams(consultation.id),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).message).toMatch(/cross-origin/i);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");
    });

    it("requires a session", async () => {
      const res = await sign(request("/api/consultations/x/sign", { method: "POST" }), idParams("x"));
      expect(res.status).toBe(401);
    });
  });

  describe("discard", () => {
    it("lets the author discard their own draft, once, with an audit row", async () => {
      const consultation = await seedConsultation(a.id, patientA, nurseA.id);
      const res = await discard(request(`/api/consultations/${consultation.id}/discard`, { method: "POST", cookie: nurseCookie }), idParams(consultation.id));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true, id: consultation.id, status: "DISCARDED" });
      const row = await db.consultation.findUnique({ where: { id: consultation.id } });
      expect(row).toMatchObject({ status: "DISCARDED", reviewedById: nurseA.id, visitId: null });
      const auditRow = await db.auditLog.findFirst({ where: { action: "consultation.discard", entityId: consultation.id } });
      expect(auditRow).toMatchObject({ actorId: nurseA.id, before: { status: "PENDING_REVIEW" }, after: { status: "DISCARDED" } });

      const again = await discard(request(`/api/consultations/${consultation.id}/discard`, { method: "POST", cookie: doctorCookie }), idParams(consultation.id));
      expect(again.status).toBe(409);
    });

    it("lets a clinician discard anyone's draft, but not a non-author nurse", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const nurse = await discard(request(`/api/consultations/${consultation.id}/discard`, { method: "POST", cookie: nurseCookie }), idParams(consultation.id));
      expect(nurse.status).toBe(403);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");

      const doctor = await discard(request(`/api/consultations/${consultation.id}/discard`, { method: "POST", cookie: doctorCookie }), idParams(consultation.id));
      expect(doctor.status).toBe(200);
      expect(await db.visit.count({ where: { patientId: patientA } })).toBe(1);
    });

    it("is a 404 across tenants, 409 for a signed consultation and 401 without a session", async () => {
      const consultation = await seedConsultation(a.id, patientA, doctorA.id);
      const foreign = await discard(request(`/api/consultations/${consultation.id}/discard`, { method: "POST", cookie: doctorBCookie }), idParams(consultation.id));
      expect(foreign.status).toBe(404);
      expect((await db.consultation.findUnique({ where: { id: consultation.id } }))?.status).toBe("PENDING_REVIEW");

      const signed = await db.consultation.findFirst({ where: { tenantId: a.id, status: "SIGNED" } });
      const sealed = await discard(request(`/api/consultations/${signed!.id}/discard`, { method: "POST", cookie: doctorCookie }), idParams(signed!.id));
      expect(sealed.status).toBe(409);

      const anonymous = await discard(request(`/api/consultations/${consultation.id}/discard`, { method: "POST" }), idParams(consultation.id));
      expect(anonymous.status).toBe(401);
    });
  });

  describe("list and get", () => {
    let foreignId: string;

    beforeAll(async () => {
      const doctorB = await db.user.findFirst({ where: { tenantId: b.id, role: "DOCTOR" } });
      foreignId = (await seedConsultation(b.id, patientB, doctorB!.id)).id;
    });

    it("lists only the tenant's consultations, drafts awaiting review first, with patient and doctor names", async () => {
      const res = await listConsultations(request("/api/consultations", { cookie: doctorCookie }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({ page: 1, pageSize: 25 });
      expect(json.total).toBe(await db.consultation.count({ where: { tenantId: a.id } }));
      const ids = json.consultations.map((c: { id: string }) => c.id);
      expect(ids).not.toContain(foreignId);
      expect(json.consultations[0].status).toBe("PENDING_REVIEW");
      const statuses: string[] = json.consultations.map((c: { status: string }) => c.status);
      const lastPending = statuses.lastIndexOf("PENDING_REVIEW");
      const firstSettled = statuses.findIndex((s) => s === "SIGNED" || s === "DISCARDED");
      expect(lastPending).toBeLessThan(firstSettled);
      expect(json.consultations[0]).toMatchObject({
        patient: { id: expect.any(String), fullName: expect.any(String) },
        doctor: { id: expect.any(String), fullName: expect.any(String) },
      });
      expect(json.consultations[0]).not.toHaveProperty("transcript");
    });

    it("filters by status and patient, paginates, and rejects an unknown status", async () => {
      const signed = await listConsultations(request("/api/consultations?status=SIGNED", { cookie: doctorCookie }));
      const signedJson = await signed.json();
      expect(signedJson.consultations.length).toBeGreaterThan(0);
      expect(signedJson.consultations.every((c: { status: string }) => c.status === "SIGNED")).toBe(true);

      const byPatient = await listConsultations(request(`/api/consultations?patientId=${patientA2}`, { cookie: doctorCookie }));
      const byPatientJson = await byPatient.json();
      expect(byPatientJson.consultations.every((c: { patient: { id: string } }) => c.patient.id === patientA2)).toBe(true);
      expect(byPatientJson.total).toBe(2);

      const page = await listConsultations(request("/api/consultations?page=2&pageSize=1", { cookie: doctorCookie }));
      const pageJson = await page.json();
      expect(pageJson).toMatchObject({ page: 2, pageSize: 1 });
      expect(pageJson.consultations).toHaveLength(1);

      const bad = await listConsultations(request("/api/consultations?status=NOPE", { cookie: doctorCookie }));
      expect(bad.status).toBe(422);
    });

    it("returns the full consultation, with a 404 for another tenant's", async () => {
      const own = await db.consultation.findFirst({ where: { tenantId: a.id, status: "SIGNED" } });
      const res = await getConsultation(request(`/api/consultations/${own!.id}`, { cookie: nurseCookie }), idParams(own!.id));
      expect(res.status).toBe(200);
      const { consultation } = await res.json();
      expect(consultation).toMatchObject({
        id: own!.id,
        status: "SIGNED",
        transcript: TRANSCRIPT,
        visitId: own!.visitId,
        patient: { id: patientA, fullName: "Alice A" },
        doctor: { id: doctorA.id, fullName: "Dr A" },
        reviewedBy: { id: doctorA.id, fullName: "Dr A" },
      });
      expect(consultation.extraction.diagnoses.length).toBeGreaterThan(0);

      const foreign = await getConsultation(request(`/api/consultations/${foreignId}`, { cookie: doctorCookie }), idParams(foreignId));
      expect(foreign.status).toBe(404);
      const missing = await getConsultation(request("/api/consultations/nope", { cookie: doctorCookie }), idParams("nope"));
      expect(missing.status).toBe(404);
      const anonymous = await getConsultation(request(`/api/consultations/${own!.id}`), idParams(own!.id));
      expect(anonymous.status).toBe(401);
    });

    it("is hidden from roles without consultations:read", async () => {
      const receptionist = await createUser({ tenantId: a.id, role: "RECEPTIONIST" });
      const cookie = await sessionCookieFor(receptionist.id);
      expect((await listConsultations(request("/api/consultations", { cookie }))).status).toBe(403);
    });
  });

  describe("extract", () => {
    it("validates the transcript and the patient/appointment scope before touching the model", async () => {
      const short = await extract(request("/api/consultations/extract", { cookie: nurseCookie, body: { patientId: patientA, transcript: "too short" } }));
      expect(short.status).toBe(422);

      const foreignPatient = await extract(request("/api/consultations/extract", { cookie: nurseCookie, body: { patientId: patientB, transcript: TRANSCRIPT } }));
      expect(foreignPatient.status).toBe(404);
      await expect(foreignPatient.json()).resolves.toEqual({ error: "not_found", entity: "patient" });

      const wrongAppointment = await extract(
        request("/api/consultations/extract", { cookie: nurseCookie, body: { patientId: patientA, transcript: TRANSCRIPT, appointmentId: appointmentA2 } }),
      );
      expect(wrongAppointment.status).toBe(404);
      await expect(wrongAppointment.json()).resolves.toEqual({ error: "not_found", entity: "appointment" });

      const crossOrigin = await extract(
        request("/api/consultations/extract", { cookie: nurseCookie, body: { patientId: patientA, transcript: TRANSCRIPT }, headers: { origin: "https://evil.example" } }),
      );
      expect(crossOrigin.status).toBe(403);

      expect(await db.consultation.count({ where: { tenantId: a.id, patientId: patientA, transcript: TRANSCRIPT, status: "PENDING_REVIEW", doctorId: nurseA.id } })).toBe(0);
    });

    it("creates a PENDING_REVIEW draft and says when nothing could be extracted (echo provider)", async () => {
      const res = await extract(
        request("/api/consultations/extract", { cookie: nurseCookie, body: { patientId: patientA, transcript: TRANSCRIPT, appointmentId: appointmentA } }),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toMatchObject({
        empty: true,
        appointmentId: appointmentA,
        summary: "",
        extraction: { symptoms: [], diagnoses: [], medications: [], tests: [], followUps: [] },
        provider: "echo",
      });
      const row = await db.consultation.findUnique({ where: { id: json.consultationId } });
      expect(row).toMatchObject({ tenantId: a.id, patientId: patientA, doctorId: nurseA.id, status: "PENDING_REVIEW", transcript: TRANSCRIPT, visitId: null });
      const auditRow = await db.auditLog.findFirst({ where: { action: "consultation.extract", entityId: json.consultationId } });
      expect(auditRow).toMatchObject({ actorId: nurseA.id, after: { empty: true, appointmentId: appointmentA } });
      // Nothing clinical was written: no visit, no new medication, appointment untouched.
      expect(await db.visit.count({ where: { patientId: patientA } })).toBe(1);
    });
  });

  describe("patient medications", () => {
    it("lists the active medications of the tenant's patient only", async () => {
      const res = await patientMedications(request(`/api/consultations/patient/${patientA}/medications`, { cookie: nurseCookie }), patientParams(patientA));
      expect(res.status).toBe(200);
      const { medications } = await res.json();
      expect(medications.map((m: { name: string }) => m.name)).toEqual(["Atorvastatin", "Metformin"]);
      expect(medications[1]).toMatchObject({ id: metforminId, dosage: "1000 mg", frequency: "twice daily" });

      const foreign = await patientMedications(request(`/api/consultations/patient/${patientB}/medications`, { cookie: nurseCookie }), patientParams(patientB));
      expect(foreign.status).toBe(404);
      const anonymous = await patientMedications(request(`/api/consultations/patient/${patientA}/medications`), patientParams(patientA));
      expect(anonymous.status).toBe(401);
    });
  });
});

describe("extraction parser", () => {
  const EMPTY = { symptoms: [], diagnoses: [], medications: [], tests: [], followUps: [] };

  it("keeps the editor's limits in step with the schema", () => {
    expect(EXTRACTION_LIMITS).toEqual({
      items: MAX_EXTRACTION_ITEMS,
      itemLength: MAX_EXTRACTION_ITEM_LENGTH,
      medicationName: MAX_MEDICATION_NAME_LENGTH,
      medicationField: MAX_MEDICATION_FIELD_LENGTH,
    });
  });

  it("tolerates fenced blocks and prose around the JSON", () => {
    const fenced = parseClinicalExtraction('Here you go:\n```json\n{"symptoms":["Cough"],"diagnoses":[],"medications":[],"tests":[],"followUps":[]}\n```\nAnything else?');
    expect(fenced).toEqual({ parsed: true, data: { ...EMPTY, symptoms: ["Cough"] } });
    const bare = parseClinicalExtraction('{"symptoms":["Fever"]}');
    expect(bare).toEqual({ parsed: true, data: { ...EMPTY, symptoms: ["Fever"] } });
  });

  it("reports unparseable output as empty instead of inventing a review", () => {
    expect(parseClinicalExtraction("I can't answer that.")).toEqual({ parsed: false, data: EMPTY });
    expect(parseClinicalExtraction("{not json}")).toEqual({ parsed: false, data: EMPTY });
    expect(parseClinicalExtraction("[1,2,3]")).toEqual({ parsed: false, data: EMPTY });
  });

  it("normalises medications, drops blanks and duplicates, and bounds lists", () => {
    const raw = JSON.stringify({
      symptoms: [" Headache ", "headache", "", 42, "x".repeat(MAX_EXTRACTION_ITEM_LENGTH + 50)],
      diagnoses: Array.from({ length: MAX_EXTRACTION_ITEMS + 10 }, (_, i) => `D${i}`),
      medications: ["Paracetamol 500 mg", { name: " Ibuprofen ", dose: "400 mg", frequency: "" }, { name: "" }, { nope: true }],
      tests: null,
      follow_ups: ["Review in 2 weeks"],
    });
    const { parsed, data } = parseClinicalExtraction(raw);
    expect(parsed).toBe(true);
    expect(data.symptoms).toEqual(["Headache", "x".repeat(MAX_EXTRACTION_ITEM_LENGTH)]);
    expect(data.diagnoses).toHaveLength(MAX_EXTRACTION_ITEMS);
    expect(data.medications).toEqual([{ name: "Paracetamol 500 mg" }, { name: "Ibuprofen", dosage: "400 mg" }]);
    expect(data.tests).toEqual([]);
    expect(data.followUps).toEqual(["Review in 2 weeks"]);
  });

  it("normalises stored drafts leniently", () => {
    expect(normaliseExtraction(null)).toEqual(EMPTY);
    expect(normaliseExtraction({ diagnoses: ["Flu"], medications: [{ name: "Oseltamivir" }] })).toEqual({
      ...EMPTY,
      diagnoses: ["Flu"],
      medications: [{ name: "Oseltamivir" }],
    });
  });
});

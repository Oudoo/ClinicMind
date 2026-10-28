/**
 * Prescribing safety against the test database: the live safety-check
 * endpoint, signing refused for unresolved stops and unacknowledged warnings
 * (always recomputed on the server), overrides written with the signature and
 * audited, and the safety-override review list and CSV export by role.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { GET as safetyCheckGet, POST as safetyCheck } from "@/app/api/consultations/[id]/safety-check/route";
import { POST as sign } from "@/app/api/consultations/[id]/sign/route";
import { GET as listOverrides } from "@/app/api/safety-overrides/route";
import { GET as exportOverrides } from "@/app/api/safety-overrides/export/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!dbTestsEnabled)("prescribing safety", () => {
  const created: string[] = [];
  let tenantA: string;
  let tenantB: string;
  let doctor: { id: string };
  let doctor2: { id: string };
  let doctorCookie: string;
  let doctor2Cookie: string;
  let ownerCookie: string;
  let nurseCookie: string;
  let receptionCookie: string;
  let doctorBCookie: string;
  /** A man of 46 with a documented penicillin allergy. */
  let allergicPatient: string;
  /** A man of 40 on warfarin. */
  let warfarinPatient: string;
  let warfarinPatientDoxyId: string;
  let foreignConsultation: string;

  async function draft(tenantId: string, patientId: string, doctorId: string, medications: { name: string; dosage?: string; frequency?: string }[]) {
    return db.consultation.create({
      data: {
        tenantId,
        patientId,
        doctorId,
        status: "PENDING_REVIEW",
        transcript: "Doctor: prescription discussed with the patient today.",
        extraction: { symptoms: [], diagnoses: [], medications, tests: [], followUps: [] },
        summary: "",
      },
    });
  }

  const signBody = (medications: { name: string; dosage?: string; frequency?: string }[], extra: Record<string, unknown> = {}) => ({
    summary: "",
    extraction: { symptoms: [], diagnoses: [], medications, tests: [], followUps: [] },
    ...extra,
  });

  beforeAll(async () => {
    const a = await createTenant({ slug: `rxa-${Date.now().toString(36)}` });
    const b = await createTenant({ slug: `rxb-${Date.now().toString(36)}` });
    created.push(a.id, b.id);
    tenantA = a.id;
    tenantB = b.id;

    doctor = await createUser({ tenantId: tenantA, role: "DOCTOR", fullName: "Dr Safety" });
    doctor2 = await createUser({ tenantId: tenantA, role: "DOCTOR", fullName: "Dr Second" });
    const owner = await createUser({ tenantId: tenantA, role: "CLINIC_OWNER", fullName: "Owner" });
    const nurse = await createUser({ tenantId: tenantA, role: "NURSE" });
    const reception = await createUser({ tenantId: tenantA, role: "RECEPTIONIST" });
    const doctorB = await createUser({ tenantId: tenantB, role: "DOCTOR" });
    doctorCookie = await sessionCookieFor(doctor.id);
    doctor2Cookie = await sessionCookieFor(doctor2.id);
    ownerCookie = await sessionCookieFor(owner.id);
    nurseCookie = await sessionCookieFor(nurse.id);
    receptionCookie = await sessionCookieFor(reception.id);
    doctorBCookie = await sessionCookieFor(doctorB.id);

    allergicPatient = (
      await db.patient.create({
        data: {
          tenantId: tenantA,
          fullName: "Penicillin Allergic",
          gender: "MALE",
          dateOfBirth: new Date("1980-04-02T00:00:00Z"),
          medicalHistory: { create: { tenantId: tenantA, allergies: ["Penicillin"], chronicConditions: ["Hypertension"] } },
        },
      })
    ).id;
    warfarinPatient = (
      await db.patient.create({
        data: {
          tenantId: tenantA,
          fullName: "On Warfarin",
          gender: "MALE",
          dateOfBirth: new Date("1986-01-10T00:00:00Z"),
          medications: {
            create: [
              { tenantId: tenantA, name: "Warfarin", dosage: "5 mg", frequency: "once daily", active: true },
              { tenantId: tenantA, name: "Doxycycline", dosage: "100 mg", frequency: "once daily", active: true },
            ],
          },
        },
        include: { medications: true },
      })
    ).id;
    warfarinPatientDoxyId = (await db.medication.findFirstOrThrow({ where: { patientId: warfarinPatient, name: "Doxycycline" } })).id;

    const patientB = await db.patient.create({ data: { tenantId: tenantB, fullName: "Foreign" } });
    foreignConsultation = (await draft(tenantB, patientB.id, doctorB.id, [{ name: "Amoxicillin" }])).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("safety-check endpoint", () => {
    it("returns the findings for the medications being edited, with what they were checked against", async () => {
      const c = await draft(tenantA, allergicPatient, doctor.id, []);
      const res = await safetyCheck(
        request(`/api/consultations/${c.id}/safety-check`, { cookie: doctorCookie, body: { medications: [{ name: "Amoxicillin", dosage: "500 mg", frequency: "three times daily" }] } }),
        idParams(c.id),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.findings).toHaveLength(1);
      expect(json.findings[0]).toMatchObject({ rule: "allergy.direct", severity: "stop", medication: "Amoxicillin" });
      expect(json.findings[0].message).toMatch(/penicillin/i);
      expect(json.context).toMatchObject({ sex: "MALE", allergies: ["Penicillin"], conditions: ["Hypertension"] });
      expect(json.context.age).toBeGreaterThanOrEqual(45);

      const azithro = await safetyCheck(
        request(`/api/consultations/${c.id}/safety-check`, { cookie: nurseCookie, body: { medications: [{ name: "Azithromycin", dosage: "500 mg" }] } }),
        idParams(c.id),
      );
      expect(azithro.status).toBe(200);
      expect((await azithro.json()).findings).toEqual([]);
    });

    it("checks the stored draft on GET and leaves stopped medications out of the comparison", async () => {
      const c = await draft(tenantA, warfarinPatient, doctor.id, [{ name: "Isotretinoin", dosage: "20 mg", frequency: "daily" }]);
      const res = await safetyCheckGet(request(`/api/consultations/${c.id}/safety-check`, { cookie: doctorCookie }), idParams(c.id));
      expect(res.status).toBe(200);
      expect((await res.json()).findings.map((f: { rule: string }) => f.rule)).toEqual(["interaction.retinoid-tetracycline"]);

      const stopped = await safetyCheck(
        request(`/api/consultations/${c.id}/safety-check`, { cookie: doctorCookie, body: { stopMedicationIds: [warfarinPatientDoxyId] } }),
        idParams(c.id),
      );
      expect((await stopped.json()).findings).toEqual([]);
    });

    it("validates the body and rejects other tenants, roles without access, anonymous and cross-origin calls", async () => {
      const c = await draft(tenantA, allergicPatient, doctor.id, []);
      const invalid = await safetyCheck(request(`/api/consultations/${c.id}/safety-check`, { cookie: doctorCookie, body: { medications: [{ name: "" }] } }), idParams(c.id));
      expect(invalid.status).toBe(422);

      const foreign = await safetyCheck(request(`/api/consultations/${foreignConsultation}/safety-check`, { cookie: doctorCookie, body: {} }), idParams(foreignConsultation));
      expect(foreign.status).toBe(404);
      const crossTenant = await safetyCheck(request(`/api/consultations/${c.id}/safety-check`, { cookie: doctorBCookie, body: {} }), idParams(c.id));
      expect(crossTenant.status).toBe(404);

      const reception = await safetyCheck(request(`/api/consultations/${c.id}/safety-check`, { cookie: receptionCookie, body: {} }), idParams(c.id));
      expect(reception.status).toBe(403);
      const anonymous = await safetyCheck(request(`/api/consultations/${c.id}/safety-check`, { body: {} }), idParams(c.id));
      expect(anonymous.status).toBe(401);
      const crossOrigin = await safetyCheck(
        request(`/api/consultations/${c.id}/safety-check`, { cookie: doctorCookie, body: {}, headers: { origin: "https://evil.example" } }),
        idParams(c.id),
      );
      expect(crossOrigin.status).toBe(403);
    });
  });

  describe("signing", () => {
    let overriddenId: string;

    it("refuses a stop without a reason and writes nothing", async () => {
      const c = await draft(tenantA, allergicPatient, doctor.id, [{ name: "Amoxicillin", dosage: "500 mg", frequency: "three times daily" }]);
      // The browser claims there is nothing to check: the server recomputes anyway.
      const res = await sign(request(`/api/consultations/${c.id}/sign`, { cookie: doctorCookie, body: { acknowledgedWarnings: true } }), idParams(c.id));
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json).toMatchObject({ error: "safety_stop", missing: [{ rule: "allergy.direct", medication: "Amoxicillin" }] });
      expect(json.findings[0]).toMatchObject({ rule: "allergy.direct", severity: "stop" });

      // A reason for another medication, or too short a reason, does not count.
      const wrongMedication = await sign(
        request(`/api/consultations/${c.id}/sign`, {
          cookie: doctorCookie,
          body: { overrides: [{ rule: "allergy.direct", medication: "Amoxil", reason: "Tolerated it last year without a rash." }] },
        }),
        idParams(c.id),
      );
      expect(wrongMedication.status).toBe(409);
      const tooShort = await sign(
        request(`/api/consultations/${c.id}/sign`, { cookie: doctorCookie, body: { overrides: [{ rule: "allergy.direct", medication: "Amoxicillin", reason: "ok fine" }] } }),
        idParams(c.id),
      );
      expect(tooShort.status).toBe(422);

      expect((await db.consultation.findUnique({ where: { id: c.id } }))?.status).toBe("PENDING_REVIEW");
      expect(await db.visit.count({ where: { patientId: allergicPatient } })).toBe(0);
      expect(await db.safetyOverride.count({ where: { consultationId: c.id } })).toBe(0);
      expect(await db.medication.count({ where: { patientId: allergicPatient } })).toBe(0);
    });

    it("signs with a reason and records the override in the same transaction, audited", async () => {
      const c = await draft(tenantA, allergicPatient, doctor.id, [{ name: "Amoxicillin", dosage: "500 mg", frequency: "three times daily" }]);
      const reason = "Allergy was a mild rash in childhood; tolerated amoxicillin in 2024.";
      const res = await sign(
        request(`/api/consultations/${c.id}/sign`, {
          cookie: doctorCookie,
          body: { overrides: [{ rule: "allergy.direct", medication: " amoxicillin ", reason }] },
        }),
        idParams(c.id),
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.safety).toEqual({ stops: 1, warnings: 0, overrides: 1 });
      expect(json.medications.started).toEqual(["Amoxicillin · 500 mg · three times daily"]);

      const rows = await db.safetyOverride.findMany({ where: { consultationId: c.id } });
      expect(rows).toHaveLength(1);
      overriddenId = rows[0]!.id;
      expect(rows[0]).toMatchObject({
        tenantId: tenantA,
        patientId: allergicPatient,
        userId: doctor.id,
        rule: "allergy.direct",
        severity: "stop",
        medication: "Amoxicillin",
        reason,
      });
      expect(rows[0]!.message).toMatch(/penicillin/i);

      const auditRow = await db.auditLog.findFirst({ where: { tenantId: tenantA, action: "consultation.safety_override", entityId: overriddenId } });
      expect(auditRow).toMatchObject({ actorId: doctor.id, entity: "SafetyOverride" });
      expect(auditRow?.after).toMatchObject({ consultationId: c.id, rule: "allergy.direct", severity: "stop", reason, visitId: json.visitId });
      const signAudit = await db.auditLog.findFirst({ where: { action: "consultation.sign", entityId: c.id } });
      expect(signAudit?.after).toMatchObject({ safety: { overrideIds: [overriddenId] } });
      expect((await db.consultation.findUnique({ where: { id: c.id } }))?.status).toBe("SIGNED");
      // The entry shows in the patient's access log.
      expect(auditRow?.patientId).toBe(allergicPatient);
      // The owner hears about every overridden stop, as its own notification kind (sent after the response).
      await vi.waitFor(
        async () => {
          const note = await db.notification.findFirst({ where: { tenantId: tenantA, kind: "SAFETY_OVERRIDE", entityId: c.id } });
          expect(note).toMatchObject({ level: "WARNING", href: "/dashboard/safety" });
        },
        { timeout: 5_000, interval: 100 },
      );
    });

    it("needs the warnings acknowledged and records each one as 'acknowledged'", async () => {
      const c = await draft(tenantA, warfarinPatient, doctor.id, [{ name: "Ibuprofen", dosage: "400 mg", frequency: "three times daily" }]);
      const refused = await sign(request(`/api/consultations/${c.id}/sign`, { cookie: doctorCookie, body: {} }), idParams(c.id));
      expect(refused.status).toBe(409);
      const json = await refused.json();
      expect(json.error).toBe("safety_warning");
      expect(json.findings.map((f: { rule: string }) => f.rule)).toEqual(["interaction.anticoagulant-nsaid"]);
      expect(await db.visit.count({ where: { patientId: warfarinPatient } })).toBe(0);

      const ok = await sign(request(`/api/consultations/${c.id}/sign`, { cookie: doctorCookie, body: { acknowledgedWarnings: true } }), idParams(c.id));
      expect(ok.status).toBe(200);
      expect((await ok.json()).safety).toEqual({ stops: 0, warnings: 1, overrides: 1 });
      const [row] = await db.safetyOverride.findMany({ where: { consultationId: c.id } });
      expect(row).toMatchObject({ severity: "warn", rule: "interaction.anticoagulant-nsaid", medication: "Ibuprofen", reason: "acknowledged", userId: doctor.id });
      expect(await db.auditLog.count({ where: { action: "consultation.safety_override", entityId: row!.id } })).toBe(1);
    });

    it("leaves a medication the clinician stops in the same signing out of the checks", async () => {
      const c = await draft(tenantA, warfarinPatient, doctor2.id, [{ name: "Isotretinoin", dosage: "20 mg", frequency: "daily" }]);
      const refused = await sign(request(`/api/consultations/${c.id}/sign`, { cookie: doctor2Cookie, body: {} }), idParams(c.id));
      expect((await refused.json()).error).toBe("safety_stop");
      const res = await sign(
        request(`/api/consultations/${c.id}/sign`, { cookie: doctor2Cookie, body: { stopMedicationIds: [warfarinPatientDoxyId] } }),
        idParams(c.id),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).medications.stopped).toEqual(["Doxycycline"]);
    });
  });

  describe("override review list", () => {
    beforeAll(async () => {
      // A second doctor's override, written as signing would.
      await db.safetyOverride.create({
        data: {
          tenantId: tenantA,
          patientId: allergicPatient,
          userId: doctor2.id,
          rule: "pregnancy.teratogen",
          severity: "stop",
          medication: "Finasteride",
          message: "Finasteride must not be taken by women who could become pregnant.",
          reason: "=Post-menopausal, off-label for hair loss",
        },
      });
    });

    it("shows the owner every clinician's overrides, with filters and counts", async () => {
      const res = await listOverrides(request("/api/safety-overrides", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.scope).toBe("all");
      expect(json.total).toBe(3);
      expect(json.counts).toEqual({ stop: 2, warn: 1 });
      expect(new Set(json.overrides.map((o: { doctor: { id: string } }) => o.doctor.id))).toEqual(new Set([doctor.id, doctor2.id]));
      expect(json.overrides[0]).toMatchObject({ patient: { id: allergicPatient, fullName: "Penicillin Allergic" } });

      const stops = await (await listOverrides(request("/api/safety-overrides?severity=stop", { cookie: ownerCookie }))).json();
      expect(stops.overrides.every((o: { severity: string }) => o.severity === "stop")).toBe(true);
      expect(stops.total).toBe(2);
      const second = await (await listOverrides(request(`/api/safety-overrides?doctorId=${doctor2.id}`, { cookie: ownerCookie }))).json();
      expect(second.overrides.map((o: { medication: string }) => o.medication)).toEqual(["Finasteride"]);
      const paged = await (await listOverrides(request("/api/safety-overrides?pageSize=1&page=2", { cookie: ownerCookie }))).json();
      expect(paged).toMatchObject({ page: 2, pageSize: 1, total: 3 });
      expect(paged.overrides).toHaveLength(1);
    });

    it("shows a doctor only their own, whatever doctor they ask for", async () => {
      const own = await (await listOverrides(request("/api/safety-overrides", { cookie: doctorCookie }))).json();
      expect(own.scope).toBe("own");
      expect(own.total).toBe(2);
      expect(own.overrides.every((o: { doctor: { id: string } }) => o.doctor.id === doctor.id)).toBe(true);
      const sneaky = await (await listOverrides(request(`/api/safety-overrides?doctorId=${doctor2.id}`, { cookie: doctorCookie }))).json();
      expect(sneaky.overrides.every((o: { doctor: { id: string } }) => o.doctor.id === doctor.id)).toBe(true);
    });

    it("is 403 for nurses and receptionists, empty for another tenant, 401 anonymous and 422 for a bad filter", async () => {
      expect((await listOverrides(request("/api/safety-overrides", { cookie: nurseCookie }))).status).toBe(403);
      expect((await listOverrides(request("/api/safety-overrides", { cookie: receptionCookie }))).status).toBe(403);
      expect((await listOverrides(request("/api/safety-overrides"))).status).toBe(401);
      const foreign = await (await listOverrides(request("/api/safety-overrides", { cookie: doctorBCookie }))).json();
      expect(foreign.total).toBe(0);
      expect((await listOverrides(request("/api/safety-overrides?severity=maybe", { cookie: ownerCookie }))).status).toBe(422);
    });

    it("exports the same list as CSV, formula-safe, audited, with the same visibility", async () => {
      const res = await exportOverrides(request("/api/safety-overrides/export", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/csv/);
      expect(res.headers.get("x-row-count")).toBe("3");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 byte-order mark for Excel
      const csv = new TextDecoder().decode(bytes);
      expect(csv).toContain("Date,Time,Doctor,Patient,Medication,Rule,Severity,Finding,Reason,Consultation");
      expect(csv).toContain("Penicillin Allergic");
      expect(csv).toContain("'=Post-menopausal"); // a leading "=" is neutralised
      expect(await db.auditLog.count({ where: { tenantId: tenantA, action: "safety_override.export" } })).toBe(1);

      const doctorCsv = await (await exportOverrides(request("/api/safety-overrides/export", { cookie: doctorCookie }))).text();
      expect(doctorCsv).not.toContain("Finasteride");
      expect((await exportOverrides(request("/api/safety-overrides/export", { cookie: nurseCookie }))).status).toBe(403);
    });

    it("lets a doctor see nothing of tenant B and keeps tenant B's list apart", async () => {
      const own = await (await listOverrides(request("/api/safety-overrides", { cookie: doctorBCookie }))).json();
      expect(own).toMatchObject({ scope: "own", total: 0, overrides: [] });
      expect(tenantB).not.toBe(tenantA);
    });
  });
});

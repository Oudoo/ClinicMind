/**
 * Only clinicians sign (audit finding #08): signing needs the role's
 * consultations:sign permission AND the person's clinician mark, which the
 * owner sets for other staff (never for themselves).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { POST as sign } from "@/app/api/consultations/[id]/sign/route";
import { PATCH as patchUser } from "@/app/api/users/[id]/route";
import { POST as invite } from "@/app/api/users/route";
import { canSignClinical } from "@/lib/auth/rbac";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("canSignClinical", () => {
  it("needs both the permission and the clinician mark", () => {
    expect(canSignClinical({ role: "DOCTOR", isClinician: true })).toBe(true);
    expect(canSignClinical({ role: "CLINIC_OWNER", isClinician: true })).toBe(true);
    expect(canSignClinical({ role: "CLINIC_OWNER", isClinician: false })).toBe(false);
    expect(canSignClinical({ role: "SUPER_ADMIN", isClinician: false })).toBe(false);
    expect(canSignClinical({ role: "NURSE", isClinician: true })).toBe(false);
    expect(canSignClinical({ role: "RECEPTIONIST", isClinician: true })).toBe(false);
  });
});

describe.skipIf(!dbTestsEnabled)("clinician mark", () => {
  const created: string[] = [];
  let tenantId: string;
  let ownerId: string;
  let ownerCookie: string;
  let aiLeadId: string;
  let aiLeadCookie: string;
  let doctorId: string;
  let doctorCookie: string;
  let patientId: string;

  beforeAll(async () => {
    const t = await createTenant();
    tenantId = t.id;
    created.push(t.id);
    const owner = await createUser({ tenantId, role: "CLINIC_OWNER" });
    const aiLead = await createUser({ tenantId, role: "CLINIC_OWNER", isClinician: false, fullName: "AI lead" });
    const doctor = await createUser({ tenantId, role: "DOCTOR" });
    ownerId = owner.id;
    aiLeadId = aiLead.id;
    doctorId = doctor.id;
    ownerCookie = await sessionCookieFor(owner.id);
    aiLeadCookie = await sessionCookieFor(aiLead.id);
    doctorCookie = await sessionCookieFor(doctor.id);
    const patient = await db.patient.create({ data: { tenantId, fullName: "Clinician Test Patient", medicalHistory: { create: { tenantId } } } });
    patientId = patient.id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  const pendingConsultation = () =>
    db.consultation.create({
      data: {
        tenantId,
        patientId,
        doctorId,
        status: "PENDING_REVIEW",
        transcript: "Doctor: follow-up. Patient: much better.",
        extraction: { symptoms: [], diagnoses: ["Acne vulgaris"], medications: [], tests: [], followUps: [] },
        summary: "Acne review. Acne vulgaris.",
      },
    });

  it("an owner-level account without the mark cannot sign; a doctor can", async () => {
    const c = await pendingConsultation();
    const refused = await sign(request(`/api/consultations/${c.id}/sign`, { cookie: aiLeadCookie, body: {} }), idParams(c.id));
    expect(refused.status).toBe(403);
    expect((await db.consultation.findUnique({ where: { id: c.id } }))?.status).toBe("PENDING_REVIEW");

    const signed = await sign(request(`/api/consultations/${c.id}/sign`, { cookie: doctorCookie, body: {} }), idParams(c.id));
    expect(signed.status).toBe(200);
  });

  it("the owner sets another person's mark, and the change is audited", async () => {
    const res = await patchUser(request(`/api/users/${aiLeadId}`, { method: "PATCH", cookie: ownerCookie, body: { isClinician: true } }), idParams(aiLeadId));
    expect(res.status).toBe(200);
    expect((await db.user.findUnique({ where: { id: aiLeadId } }))?.isClinician).toBe(true);
    const row = await db.auditLog.findFirst({ where: { tenantId, action: "user.clinician", entityId: aiLeadId } });
    expect(row?.after).toEqual({ isClinician: true });

    const back = await patchUser(request(`/api/users/${aiLeadId}`, { method: "PATCH", cookie: ownerCookie, body: { isClinician: false } }), idParams(aiLeadId));
    expect(back.status).toBe(200);
    expect((await db.user.findUnique({ where: { id: aiLeadId } }))?.isClinician).toBe(false);
  });

  it("nobody changes their own mark", async () => {
    const res = await patchUser(request(`/api/users/${aiLeadId}`, { method: "PATCH", cookie: aiLeadCookie, body: { isClinician: true } }), idParams(aiLeadId));
    expect(res.status).toBe(403);
    expect((await db.user.findUnique({ where: { id: aiLeadId } }))?.isClinician).toBe(false);
    const own = await patchUser(request(`/api/users/${ownerId}`, { method: "PATCH", cookie: ownerCookie, body: { isClinician: false } }), idParams(ownerId));
    expect(own.status).toBe(403);
  });

  it("doctors cannot change marks, and another clinic's user is a 404", async () => {
    const res = await patchUser(request(`/api/users/${aiLeadId}`, { method: "PATCH", cookie: doctorCookie, body: { isClinician: true } }), idParams(aiLeadId));
    expect(res.status).toBe(403);
    const other = await createTenant();
    created.push(other.id);
    const stranger = await createUser({ tenantId: other.id, role: "DOCTOR" });
    const foreign = await patchUser(request(`/api/users/${stranger.id}`, { method: "PATCH", cookie: ownerCookie, body: { isClinician: false } }), idParams(stranger.id));
    expect(foreign.status).toBe(404);
  });

  it("invitations: doctors default to clinician, others only when asked", async () => {
    const asDoctor = await invite(request("/api/users", { cookie: ownerCookie, body: { email: `doc-${Date.now()}@example.test`, role: "DOCTOR" } }));
    expect(asDoctor.status).toBe(201);
    expect((await asDoctor.json()).user.isClinician).toBe(true);
    const asOwner = await invite(request("/api/users", { cookie: ownerCookie, body: { email: `mgr-${Date.now()}@example.test`, role: "CLINIC_OWNER" } }));
    expect((await asOwner.json()).user.isClinician).toBe(false);
    const asNurse = await invite(request("/api/users", { cookie: ownerCookie, body: { email: `nurse-${Date.now()}@example.test`, role: "NURSE", isClinician: true } }));
    expect((await asNurse.json()).user.isClinician).toBe(true);
  });
});

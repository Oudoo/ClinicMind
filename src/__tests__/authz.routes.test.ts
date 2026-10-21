/**
 * Every protected route answers 401 without a session, and a session of
 * tenant A never reaches tenant B's data. Runs against the test database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { GET as me } from "@/app/api/me/route";
import { GET as listPatients, POST as createPatient } from "@/app/api/patients/route";
import { GET as listAppointments, POST as createAppointment } from "@/app/api/appointments/route";
import { GET as listTenants, POST as provisionTenant } from "@/app/api/tenants/route";
import { POST as assistant } from "@/app/api/assistant/route";
import { POST as extract } from "@/app/api/consultations/extract/route";
import { POST as sign } from "@/app/api/consultations/[id]/sign/route";
import { GET as listUsers, POST as inviteMember } from "@/app/api/users/route";
import { POST as resendInvite } from "@/app/api/users/[id]/invite/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import {
  createTenant,
  createUser,
  dbTestsEnabled,
  deleteTenants,
  request,
  sessionCookieFor,
} from "@/test/db";

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

const PROTECTED: { name: string; handler: Handler; method: "GET" | "POST" }[] = [
  { name: "GET /api/me", handler: me, method: "GET" },
  { name: "GET /api/patients", handler: listPatients, method: "GET" },
  { name: "POST /api/patients", handler: createPatient, method: "POST" },
  { name: "GET /api/appointments", handler: listAppointments, method: "GET" },
  { name: "POST /api/appointments", handler: createAppointment, method: "POST" },
  { name: "GET /api/tenants", handler: listTenants, method: "GET" },
  { name: "POST /api/tenants", handler: provisionTenant, method: "POST" },
  { name: "POST /api/assistant", handler: assistant, method: "POST" },
  { name: "POST /api/consultations/extract", handler: extract, method: "POST" },
  { name: "POST /api/consultations/[id]/sign", handler: sign, method: "POST" },
  { name: "GET /api/users", handler: listUsers, method: "GET" },
  { name: "POST /api/users", handler: inviteMember, method: "POST" },
  { name: "POST /api/users/[id]/invite", handler: resendInvite, method: "POST" },
];

describe.skipIf(!dbTestsEnabled)("authorization", () => {
  const created: string[] = [];
  let a: { id: string; slug: string };
  let b: { id: string; slug: string };
  let aOwnerCookie: string;
  let aDoctorCookie: string;
  let aPatientId: string;
  let bPatientId: string;
  let bUserId: string;
  let bConsultationId: string;

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `a-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `b-${Date.now().toString(36)}` });
    created.push(tenantA.id, tenantB.id);
    a = tenantA;
    b = tenantB;

    const aOwner = await createUser({ tenantId: a.id, role: "CLINIC_OWNER" });
    const aDoctor = await createUser({ tenantId: a.id, role: "DOCTOR" });
    aOwnerCookie = await sessionCookieFor(aOwner.id);
    aDoctorCookie = await sessionCookieFor(aDoctor.id);

    const bOwner = await createUser({ tenantId: b.id, role: "CLINIC_OWNER" });
    bUserId = bOwner.id;

    aPatientId = (await db.patient.create({ data: { tenantId: a.id, fullName: "Patient Of A" } })).id;
    bPatientId = (await db.patient.create({ data: { tenantId: b.id, fullName: "Patient Of B" } })).id;

    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const later = new Date(soon.getTime() + 30 * 60 * 1000);
    await db.appointment.create({ data: { tenantId: a.id, patientId: aPatientId, startsAt: soon, endsAt: later } });
    await db.appointment.create({ data: { tenantId: b.id, patientId: bPatientId, startsAt: soon, endsAt: later } });

    bConsultationId = (
      await db.consultation.create({
        data: { tenantId: b.id, patientId: bPatientId, status: "PENDING_REVIEW", transcript: "…" },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("unauthenticated requests get 401", () => {
    for (const route of PROTECTED) {
      it(`${route.name} without credentials`, async () => {
        const res = await route.handler(request("/api/x", { method: route.method }), { params: Promise.resolve({ id: "x" }) });
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe("unauthorized");
      });

      it(`${route.name} with an unknown session cookie`, async () => {
        const res = await route.handler(
          request("/api/x", { method: route.method, cookie: `${SESSION_COOKIE}=not-a-real-token` }),
          { params: Promise.resolve({ id: "x" }) },
        );
        expect(res.status).toBe(401);
      });

      it(`${route.name} ignores the legacy x-clinicmind-tenant header`, async () => {
        const res = await route.handler(
          request("/api/x", { method: route.method, headers: { "x-clinicmind-tenant": a.slug } }),
          { params: Promise.resolve({ id: "x" }) },
        );
        expect(res.status).toBe(401);
      });
    }

    it("a revoked session is as good as none", async () => {
      const user = await createUser({ tenantId: a.id, role: "NURSE" });
      const cookie = await sessionCookieFor(user.id);
      expect((await me(request("/api/me", { cookie }))).status).toBe(200);
      await logout(request("/api/auth/logout", { method: "POST", cookie }));
      expect((await listPatients(request("/api/patients", { cookie }))).status).toBe(401);
    });

    it("a session of a suspended tenant is rejected", async () => {
      const suspended = await createTenant();
      created.push(suspended.id);
      const user = await createUser({ tenantId: suspended.id });
      const cookie = await sessionCookieFor(user.id);
      expect((await me(request("/api/me", { cookie }))).status).toBe(200);
      await db.tenant.update({ where: { id: suspended.id }, data: { status: "SUSPENDED" } });
      expect((await me(request("/api/me", { cookie }))).status).toBe(401);
    });
  });

  describe("tenant isolation", () => {
    it("/api/me reports the session's own tenant", async () => {
      const res = await me(request("/api/me", { cookie: aOwnerCookie }));
      expect((await res.json()).tenant.id).toBe(a.id);
    });

    it("tenant A cannot list tenant B's patients", async () => {
      const res = await listPatients(request("/api/patients", { cookie: aOwnerCookie }));
      expect(res.status).toBe(200);
      const ids = (await res.json()).patients.map((p: { id: string }) => p.id);
      expect(ids).toContain(aPatientId);
      expect(ids).not.toContain(bPatientId);
    });

    it("tenant A cannot list tenant B's appointments", async () => {
      const res = await listAppointments(request("/api/appointments", { cookie: aOwnerCookie }));
      expect(res.status).toBe(200);
      const patients = (await res.json()).appointments.map((x: { patientId: string }) => x.patientId);
      expect(patients).toContain(aPatientId);
      expect(patients).not.toContain(bPatientId);
    });

    it("tenant A's doctor cannot sign tenant B's consultation", async () => {
      const res = await sign(
        request(`/api/consultations/${bConsultationId}/sign`, { cookie: aDoctorCookie, body: {} }),
        { params: Promise.resolve({ id: bConsultationId }) },
      );
      expect(res.status).toBe(404);
      const untouched = await db.consultation.findUnique({ where: { id: bConsultationId } });
      expect(untouched?.status).toBe("PENDING_REVIEW");
    });

    it("tenant A cannot see or re-invite tenant B's staff", async () => {
      const list = await listUsers(request("/api/users", { cookie: aOwnerCookie }));
      const ids = (await list.json()).users.map((u: { id: string }) => u.id);
      expect(ids).not.toContain(bUserId);

      const resend = await resendInvite(
        request(`/api/users/${bUserId}/invite`, { method: "POST", cookie: aOwnerCookie }),
        { params: Promise.resolve({ id: bUserId }) },
      );
      expect(resend.status).toBe(404);
    });

    it("roles are enforced on top of authentication", async () => {
      const nurse = await createUser({ tenantId: a.id, role: "NURSE" });
      const cookie = await sessionCookieFor(nurse.id);
      expect((await listPatients(request("/api/patients", { cookie }))).status).toBe(200);
      expect((await listUsers(request("/api/users", { cookie }))).status).toBe(403);
      expect((await sign(request("/api/x", { cookie, body: {} }), { params: Promise.resolve({ id: "x" }) })).status).toBe(403);
    });
  });
});

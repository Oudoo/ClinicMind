/**
 * The owner's audit-log screen (Phase 1): the log is searchable by person,
 * patient, activity and date, exports to CSV (and the export is itself
 * logged), never shows another clinic's entries, and is closed to everyone
 * without audit:read. Also covers the entries this phase adds: sign-ins,
 * failed sign-ins, sign-outs and record views.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { audit, resolveAuditPatientId } from "@/lib/audit";
import { resetRateLimits } from "@/lib/auth/rate-limit";
import { GET as listLogs } from "@/app/api/audit-logs/route";
import { GET as exportLogs } from "@/app/api/audit-logs/export/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as forgot } from "@/app/api/auth/password/forgot/route";
import { GET as financeExport } from "@/app/api/finance/export/route";
import { GET as reportExport } from "@/app/api/reports/export/route";
import { recordPatientView } from "@/modules/audit/views";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const PASSWORD = "correct horse battery staple";

vi.mock("@/lib/mailer", () => ({
  sendMail: async () => undefined,
  mailer: () => ({ name: "console", send: async () => undefined }),
}));

interface Entry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  actor: { id: string | null; name: string };
  patient: { id: string; fullName: string } | null;
  changes: { field: string; from: string | null; to: string | null }[];
}

describe.skipIf(!dbTestsEnabled)("audit log", () => {
  const created: string[] = [];
  let tenantId: string;
  let ownerId: string;
  let ownerEmail: string;
  let ownerCookie: string;
  let doctorId: string;
  let doctorCookie: string;
  let receptionCookie: string;
  let patientId: string;
  let otherPatientId: string;
  let appointmentId: string;
  let foreignPatientId: string;

  beforeAll(async () => {
    const t = await createTenant({ name: "Audit Clinic" });
    tenantId = t.id;
    created.push(t.id);
    const owner = await createUser({ tenantId, role: "CLINIC_OWNER", fullName: "Owner Olfat", password: PASSWORD });
    ownerId = owner.id;
    ownerEmail = owner.email;
    ownerCookie = await sessionCookieFor(owner.id);
    const doctor = await createUser({ tenantId, role: "DOCTOR", fullName: "Dr Dina" });
    doctorId = doctor.id;
    doctorCookie = await sessionCookieFor(doctor.id);
    const reception = await createUser({ tenantId, role: "RECEPTIONIST", fullName: "Reem Reception" });
    receptionCookie = await sessionCookieFor(reception.id);

    const patient = await db.patient.create({ data: { tenantId, fullName: "Audit Patient Amal", medicalHistory: { create: { tenantId } } } });
    patientId = patient.id;
    const other = await db.patient.create({ data: { tenantId, fullName: "Audit Patient Bassem", medicalHistory: { create: { tenantId } } } });
    otherPatientId = other.id;
    const clinic = await db.clinic.create({ data: { tenantId, name: "Main", timezone: "Africa/Cairo" } });
    const start = new Date(Date.now() + 3 * 86_400_000);
    const appointment = await db.appointment.create({
      data: { tenantId, clinicId: clinic.id, patientId, doctorId, startsAt: start, endsAt: new Date(start.getTime() + 30 * 60_000) },
    });
    appointmentId = appointment.id;

    const foreign = await createTenant({ name: "Elsewhere Clinic" });
    created.push(foreign.id);
    const foreignPatient = await db.patient.create({ data: { tenantId: foreign.id, fullName: "Foreign Patient", medicalHistory: { create: { tenantId: foreign.id } } } });
    foreignPatientId = foreignPatient.id;

    // A small history, oldest first.
    await audit({ tenantId, actorId: ownerId, actorEmail: ownerEmail, action: "tenant.branding", entity: "Tenant", entityId: tenantId, before: { primaryColor: "#000" }, after: { primaryColor: "#0a7" } });
    await audit({ tenantId, actorId: doctorId, actorEmail: doctor.email, action: "patient.update", entity: "Patient", entityId: patientId, before: { phone: "+201000000001" }, after: { phone: "+201000000002" } });
    await audit({ tenantId, actorId: doctorId, actorEmail: doctor.email, action: "appointment.transition", entity: "Appointment", entityId: appointmentId, before: { status: "SCHEDULED" }, after: { status: "CONFIRMED" } });
    await audit({ tenantId, actorId: doctorId, actorEmail: doctor.email, action: "consultation.sign", entity: "Consultation", entityId: "c-missing", after: { patientId: otherPatientId, diagnoses: ["Acne"] } });
    await audit({ tenantId, action: "notification.digest", entity: "Notification", entityId: null });
    await audit({ tenantId: foreign.id, actorId: null, action: "patient.update", entity: "Patient", entityId: foreignPatientId, after: { fullName: "Foreign Patient" } });
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  beforeEach(() => {
    resetRateLimits();
  });

  const list = async (qs: string, cookie = ownerCookie) => {
    const res = await listLogs(request(`/api/audit-logs${qs}`, { cookie }));
    return { res, body: (await res.json()) as { entries: Entry[]; total: number; page: number; pageSize: number } };
  };
  const actions = (entries: Entry[]) => entries.map((e) => e.action);

  describe("patient of an entry", () => {
    it("comes from the Patient entity, a snapshot patientId, or the row the entry names", async () => {
      const rows = await db.auditLog.findMany({ where: { tenantId }, select: { action: true, patientId: true } });
      const byAction = new Map(rows.map((r) => [r.action, r.patientId]));
      expect(byAction.get("patient.update")).toBe(patientId);
      expect(byAction.get("appointment.transition")).toBe(patientId); // looked up from the appointment
      expect(byAction.get("consultation.sign")).toBe(otherPatientId); // from the after snapshot
      expect(byAction.get("tenant.branding")).toBeNull();
      expect(byAction.get("notification.digest")).toBeNull();
    });

    it("never takes a patient from another clinic's row", async () => {
      const id = await resolveAuditPatientId({ tenantId, action: "appointment.update", entity: "Appointment", entityId: "nope" });
      expect(id).toBeNull();
      const explicit = await resolveAuditPatientId({ tenantId, action: "x.y", entity: "Appointment", entityId: appointmentId, patientId: null });
      expect(explicit).toBeNull();
    });
  });

  describe("GET /api/audit-logs", () => {
    it("lists this clinic's entries newest first, with people, patients and changes", async () => {
      const { res, body } = await list("");
      expect(res.status).toBe(200);
      expect(actions(body.entries)).toEqual(["notification.digest", "consultation.sign", "appointment.transition", "patient.update", "tenant.branding"]);
      expect(body.total).toBe(5);
      const update = body.entries.find((e) => e.action === "patient.update")!;
      expect(update.actor).toMatchObject({ id: doctorId, name: "Dr Dina" });
      expect(update.patient).toMatchObject({ id: patientId, fullName: "Audit Patient Amal" });
      expect(update.changes).toEqual([{ field: "phone", from: "+201000000001", to: "+201000000002" }]);
      const automated = body.entries.find((e) => e.action === "notification.digest")!;
      expect(automated.actor).toMatchObject({ id: null, name: "ClinicMind (automatic)" });
      expect(body.entries.some((e) => e.patient?.id === foreignPatientId)).toBe(false);
    });

    it("filters by person, automated entries, patient, activity, exact action and text", async () => {
      expect(actions((await list(`?actor=${doctorId}`)).body.entries)).toEqual(["consultation.sign", "appointment.transition", "patient.update"]);
      expect(actions((await list("?actor=system")).body.entries)).toEqual(["notification.digest"]);
      expect(actions((await list(`?patient=${patientId}`)).body.entries)).toEqual(["appointment.transition", "patient.update"]);
      expect(actions((await list("?action=appointment")).body.entries)).toEqual(["appointment.transition"]);
      expect(actions((await list("?action=tenant.branding")).body.entries)).toEqual(["tenant.branding"]);
      expect(actions((await list(`?q=${appointmentId}`)).body.entries)).toEqual(["appointment.transition"]);
      expect(actions((await list("?q=BRANDING")).body.entries)).toEqual(["tenant.branding"]);
    });

    it("filters by clinic-calendar dates", async () => {
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
      expect((await list(`?from=${today}&to=${today}`)).body.total).toBe(5);
      expect((await list("?from=2020-01-01&to=2020-01-31")).body.total).toBe(0);
      // A reversed range reads as the range meant.
      expect((await list(`?from=${today}&to=2020-01-01`)).body.total).toBe(5);
    });

    it("shows the last page for a page past the end", async () => {
      const { body } = await list("?page=99");
      expect(body.page).toBe(1);
      expect(body.entries).toHaveLength(5);
    });

    it("never shows another clinic's entries, even by id", async () => {
      const { body } = await list(`?patient=${foreignPatientId}`);
      expect(body.total).toBe(0);
    });

    it("is for audit:read only", async () => {
      expect((await list("", doctorCookie)).res.status).toBe(403);
      expect((await list("", receptionCookie)).res.status).toBe(403);
      const anonymous = await listLogs(request("/api/audit-logs"));
      expect(anonymous.status).toBe(401);
    });
  });

  describe("GET /api/audit-logs/export", () => {
    it("streams the filtered log as CSV and logs the export", async () => {
      const res = await exportLogs(request(`/api/audit-logs/export?patient=${patientId}`, { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"/);
      expect(res.headers.get("x-row-count")).toBe("2");
      const bytes = new Uint8Array(await res.arrayBuffer());
      // UTF-8 byte-order mark, so Excel reads Arabic names correctly (Response.text() would strip it).
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes);
      const lines = text.trim().split("\r\n");
      expect(lines[0]).toBe(
        "Time (UTC),Date,Time,Person,E-mail,Action,Action code,Record,Record ID,Patient,Patient ID,IP,Device,Changes,Before,After",
      );
      expect(lines).toHaveLength(3);
      expect(lines[1]).toContain("appointment.transition");
      expect(lines[2]).toContain("Audit Patient Amal");
      expect(lines[2]).toContain("phone:");
      expect(text).not.toContain("Foreign Patient");

      const logged = await db.auditLog.findFirst({ where: { tenantId, action: "audit.export" }, orderBy: { createdAt: "desc" } });
      expect(logged).toMatchObject({ actorId: ownerId, patientId: null });
      expect(logged?.after).toMatchObject({ rows: 2, truncated: false, filters: { patient: patientId } });
    });

    it("holds exactly the entries that existed when it was asked for", async () => {
      const exportsBefore = await db.auditLog.count({ where: { tenantId, action: "audit.export" } });
      const res = await exportLogs(request("/api/audit-logs/export", { cookie: ownerCookie }));
      expect(res.status).toBe(200);
      // Written while the file is still downloading: it must not push the oldest entry out.
      await audit({ tenantId, actorId: ownerId, actorEmail: ownerEmail, action: "tenant.update", entity: "Tenant", entityId: tenantId });
      const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
      const lines = text.trim().split("\r\n").slice(1);
      expect(lines).toHaveLength(Number(res.headers.get("x-row-count")));
      expect(lines.some((l) => l.includes("tenant.branding"))).toBe(true);
      expect(lines.some((l) => l.includes("tenant.update"))).toBe(false);
      // Its own entry is not in the file; earlier exports are.
      expect(lines.filter((l) => l.includes("audit.export"))).toHaveLength(exportsBefore);
    });

    it("is for audit:read only", async () => {
      const res = await exportLogs(request("/api/audit-logs/export", { cookie: doctorCookie }));
      expect(res.status).toBe(403);
    });
  });

  describe("sign-in, sign-out and record views", () => {
    it("logs a sign-in, a failed sign-in and a sign-out, with no password", async () => {
      const ok = await login(request("/api/auth/login", { body: { email: ownerEmail, password: PASSWORD }, headers: { "x-forwarded-for": "198.51.100.7" } }));
      expect(ok.status).toBe(200);
      const bad = await login(request("/api/auth/login", { body: { email: ownerEmail, password: "not the password" } }));
      expect(bad.status).toBe(401);

      const signIn = await db.auditLog.findFirst({ where: { tenantId, action: "auth.login" }, orderBy: { createdAt: "desc" } });
      expect(signIn).toMatchObject({ actorId: ownerId, entity: "User", entityId: ownerId, ip: "198.51.100.7", patientId: null });
      const failed = await db.auditLog.findFirst({ where: { tenantId, action: "auth.login_failed" }, orderBy: { createdAt: "desc" } });
      expect(failed).toMatchObject({ actorId: ownerId });
      expect(failed?.after).toEqual({ reason: "wrong_password" });
      expect(JSON.stringify([signIn, failed])).not.toContain(PASSWORD);

      const cookie = await sessionCookieFor(ownerId);
      const out = await logout(request("/api/auth/logout", { method: "POST", cookie }));
      expect(out.status).toBe(200);
      expect(out.headers.get("clear-site-data")).toBe('"cache", "storage"');
      expect(await db.auditLog.count({ where: { tenantId, action: "auth.logout", actorId: ownerId } })).toBe(1);
      const signIns = await list("?action=auth");
      expect(actions(signIns.body.entries)).toEqual(["auth.logout", "auth.login_failed", "auth.login"]);
    });

    it("counts repeat views of one record by one person once per ten minutes", async () => {
      const view = { tenantId, patientId: otherPatientId, actorEmail: null, ip: null, device: null };
      await recordPatientView({ ...view, actorId: doctorId });
      await recordPatientView({ ...view, actorId: doctorId });
      await recordPatientView({ ...view, actorId: ownerId });
      const rows = await db.auditLog.findMany({ where: { tenantId, action: "patient.record.view", patientId: otherPatientId } });
      expect(rows.map((r) => r.actorId).sort()).toEqual([doctorId, ownerId].sort());
    });
  });

  describe("exports and password resets", () => {
    it("logs finance and report exports with what was exported", async () => {
      const fin = await financeExport(request("/api/finance/export?kind=payments&period=90d", { cookie: ownerCookie }));
      expect(fin.status).toBe(200);
      const rep = await reportExport(request("/api/reports/export?metric=M2&part=source&period=90d", { cookie: ownerCookie }));
      expect(rep.status).toBe(200);
      const finance = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: "finance.export" } });
      expect(finance).toMatchObject({ actorId: ownerId, entity: "Finance", entityId: "payments", patientId: null });
      expect(finance.after).toMatchObject({ kind: "payments", rows: 0 });
      const report = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: "report.export" } });
      expect(report).toMatchObject({ actorId: ownerId, entity: "Report", entityId: "M2" });
      expect(report.after).toMatchObject({ metric: "M2", part: "source" });

      const exports = await list("?action=exports");
      expect(new Set(actions(exports.body.entries))).toEqual(new Set(["finance.export", "report.export", "audit.export"]));
    });

    it("logs a password-reset request against the account it names, as not signed in", async () => {
      const res = await forgot(request("/api/auth/password/forgot", { body: { email: ownerEmail }, headers: { "x-forwarded-for": "203.0.113.9" } }));
      expect(res.status).toBe(200);
      const row = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: "auth.password_reset_requested" } });
      expect(row).toMatchObject({ actorId: null, actorEmail: ownerEmail, entity: "User", entityId: ownerId, ip: "203.0.113.9" });
      expect(row.after).toEqual({ sent: "reset_link" });

      const anonymous = await list("?actor=anonymous");
      expect(actions(anonymous.body.entries)).toEqual(["auth.password_reset_requested"]);
      expect(anonymous.body.entries[0]!.actor.name).toBe(`${ownerEmail} (not signed in)`);
      // Automated entries stay separate from requests made at the sign-in page.
      expect(actions((await list("?actor=system")).body.entries)).toEqual(["notification.digest"]);
    });
  });

  it("cannot be edited or deleted", async () => {
    const row = await db.auditLog.findFirstOrThrow({ where: { tenantId } });
    await expect(db.auditLog.update({ where: { id: row.id }, data: { action: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(db.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });
});

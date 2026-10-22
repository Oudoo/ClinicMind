/**
 * Patient module routes against the test database: paging and search,
 * validation, partial updates, archive/restore, medical history and the
 * tenant and role boundaries.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { GET as list, POST as create } from "@/app/api/patients/route";
import { DELETE as archive, GET as get, PATCH as update } from "@/app/api/patients/[id]/route";
import { POST as restore } from "@/app/api/patients/[id]/restore/route";
import { PATCH as updateHistory } from "@/app/api/patients/[id]/history/route";
import {
  createTenant,
  createUser,
  dbTestsEnabled,
  deleteTenants,
  request,
  sessionCookieFor,
} from "@/test/db";

const params = (id: string) => ({ params: Promise.resolve({ id }) });

interface PatientJson {
  id: string;
  fullName: string;
  deletedAt: string | null;
  [key: string]: unknown;
}

describe.skipIf(!dbTestsEnabled)("patients routes", () => {
  const created: string[] = [];
  let tenantId: string;
  let ownerId: string;
  let owner: string;
  let assistant: string;
  let foreign: string;

  beforeAll(async () => {
    const a = await createTenant();
    const b = await createTenant();
    created.push(a.id, b.id);
    tenantId = a.id;

    const ownerUser = await createUser({ tenantId: a.id, role: "CLINIC_OWNER", fullName: "Dr. Layla Hassan" });
    ownerId = ownerUser.id;
    owner = await sessionCookieFor(ownerUser.id);
    assistant = await sessionCookieFor((await createUser({ tenantId: a.id, role: "ASSISTANT" })).id);
    foreign = await sessionCookieFor((await createUser({ tenantId: b.id, role: "CLINIC_OWNER" })).id);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  async function createVia(body: Record<string, unknown>, cookie = owner): Promise<PatientJson> {
    const res = await create(request("/api/patients", { body, cookie }));
    expect(res.status).toBe(201);
    return (await res.json()).patient as PatientJson;
  }

  async function listed(query: string, cookie = owner) {
    const res = await list(request(`/api/patients${query}`, { cookie }));
    expect(res.status).toBe(200);
    return (await res.json()) as { patients: PatientJson[]; total: number; page: number; pageSize: number };
  }

  describe("listing", () => {
    let cookie: string;

    beforeAll(async () => {
      // A tenant of its own keeps the counts deterministic.
      const tenant = await createTenant();
      created.push(tenant.id);
      cookie = await sessionCookieFor((await createUser({ tenantId: tenant.id, role: "RECEPTIONIST" })).id);
      for (const body of [
        { fullName: "Ahmed Mahmoud", phone: "+20 100 000 0001", email: "ahmed@example.test", tags: ["vip"] },
        { fullName: "Sara Ibrahim", phone: "+201000000002" },
        { fullName: "Mohamed Saleh", email: "mo.saleh@example.test" },
      ]) {
        await createVia(body, cookie);
      }
    });

    it("pages newest first inside the envelope", async () => {
      const page1 = await listed("?pageSize=2", cookie);
      expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(page1.patients.map((p) => p.fullName)).toEqual(["Mohamed Saleh", "Sara Ibrahim"]);
      expect(page1.patients[0]).toMatchObject({ _count: { appointments: 0, visits: 0 } });
      expect(page1.patients[0]?.medicalHistory).toBeTruthy();

      const page2 = await listed("?pageSize=2&page=2", cookie);
      expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page2.patients.map((p) => p.fullName)).toEqual(["Ahmed Mahmoud"]);
    });

    it("clamps paging to sane bounds", async () => {
      expect(await listed("?pageSize=1000&page=-3", cookie)).toMatchObject({ page: 1, pageSize: 100 });
      expect(await listed("?pageSize=abc", cookie)).toMatchObject({ page: 1, pageSize: 25 });
    });

    it("searches by name, phone and e-mail", async () => {
      const names = async (q: string) =>
        (await listed(`?q=${encodeURIComponent(q)}`, cookie)).patients.map((p) => p.fullName);
      expect(await names("sara")).toEqual(["Sara Ibrahim"]);
      expect(await names("0100 000 0002")).toEqual(["Sara Ibrahim"]);
      expect(await names("+201000000001")).toEqual(["Ahmed Mahmoud"]);
      expect(await names("SALEH@")).toEqual(["Mohamed Saleh"]);
      expect(await names("nobody")).toEqual([]);
    });

    it("filters by tag", async () => {
      expect((await listed("?tag=vip", cookie)).patients.map((p) => p.fullName)).toEqual(["Ahmed Mahmoud"]);
      expect((await listed("?tag=none", cookie)).total).toBe(0);
    });
  });

  describe("create", () => {
    it("rejects an empty body with field errors", async () => {
      const res = await create(request("/api/patients", { body: {}, cookie: owner }));
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toBe("validation_error");
      expect(body.issues.fieldErrors.fullName).toBeDefined();
    });

    it("validates every field", async () => {
      const res = await create(
        request("/api/patients", {
          cookie: owner,
          body: {
            fullName: "x".repeat(121),
            gender: "ROBOT",
            dateOfBirth: "2999-01-01",
            phone: "12",
            email: "nope",
            language: "fr",
            tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
          },
        }),
      );
      expect(res.status).toBe(422);
      const { fieldErrors } = (await res.json()).issues;
      expect(Object.keys(fieldErrors).sort()).toEqual([
        "dateOfBirth",
        "email",
        "fullName",
        "gender",
        "language",
        "phone",
        "tags",
      ]);
    });

    it("normalizes the profile and writes the history row and an audit entry", async () => {
      const res = await create(
        request("/api/patients", {
          cookie: owner,
          body: {
            fullName: "  Ahmed Mahmoud ",
            gender: "MALE",
            dateOfBirth: "1984-03-10",
            phone: "+20 (100) 000-0001",
            whatsapp: "",
            email: "Ahmed@Example.test",
            tags: ["vip", " VIP ", "diabetic", ""],
            language: "en",
            notes: "   ",
          },
        }),
      );
      expect(res.status).toBe(201);
      const { patient } = await res.json();
      expect(patient).toMatchObject({
        tenantId,
        fullName: "Ahmed Mahmoud",
        gender: "MALE",
        phone: "+201000000001",
        whatsapp: null,
        email: "ahmed@example.test",
        tags: ["vip", "diabetic"],
        language: "en",
        notes: null,
        deletedAt: null,
      });
      expect(patient.dateOfBirth).toMatch(/^1984-03-10T00:00:00/);
      expect(patient.medicalHistory).toMatchObject({ tenantId, patientId: patient.id, diagnoses: [] });

      const log = await db.auditLog.findFirst({ where: { tenantId, action: "patient.create", entityId: patient.id } });
      expect(log?.actorId).toBe(ownerId);
      expect(log?.after).toMatchObject({ fullName: "Ahmed Mahmoud", phone: "+201000000001" });
    });

    it("rejects a cross-origin browser submission", async () => {
      const res = await create(
        request("/api/patients", {
          cookie: owner,
          body: { fullName: "Evil" },
          headers: { origin: "https://evil.example", host: "localhost:3000" },
        }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("update", () => {
    it("applies a partial patch, clears blanks and audits before/after", async () => {
      const p = await createVia({ fullName: "Nour El-Din", phone: "+201000000009", notes: "Prefers mornings" });
      const res = await update(
        request(`/api/patients/${p.id}`, {
          method: "PATCH",
          cookie: owner,
          body: { fullName: "Nour El-Din Ali", phone: "", tags: ["follow-up", "Follow-Up"] },
        }),
        params(p.id),
      );
      expect(res.status).toBe(200);
      const { patient } = await res.json();
      expect(patient).toMatchObject({
        id: p.id,
        fullName: "Nour El-Din Ali",
        phone: null,
        notes: "Prefers mornings",
        tags: ["follow-up"],
      });

      const log = await db.auditLog.findFirst({ where: { tenantId, action: "patient.update", entityId: p.id } });
      expect(log?.before).toEqual({ fullName: "Nour El-Din", phone: "+201000000009", tags: [] });
      expect(log?.after).toEqual({ fullName: "Nour El-Din Ali", phone: null, tags: ["follow-up"] });
      expect(await db.timelineEvent.count({ where: { tenantId, patientId: p.id } })).toBe(0);
    });

    it("validates the patch", async () => {
      const p = await createVia({ fullName: "Validate Me" });
      const res = await update(
        request(`/api/patients/${p.id}`, { method: "PATCH", cookie: owner, body: { email: "nope", fullName: "" } }),
        params(p.id),
      );
      expect(res.status).toBe(422);
      const { fieldErrors } = (await res.json()).issues;
      expect(Object.keys(fieldErrors).sort()).toEqual(["email", "fullName"]);
    });

    it("404s for an unknown id", async () => {
      const res = await update(
        request("/api/patients/nope", { method: "PATCH", cookie: owner, body: { fullName: "X" } }),
        params("nope"),
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", entity: "patient" });
    });
  });

  describe("archive & restore", () => {
    it("hides the patient from the registry until restored", async () => {
      const p = await createVia({ fullName: "Fatma Adel" });
      const ids = async (query: string) => (await listed(query)).patients.map((x) => x.id);

      const del = await archive(request(`/api/patients/${p.id}`, { method: "DELETE", cookie: owner }), params(p.id));
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });

      expect(await ids("?q=Fatma")).not.toContain(p.id);
      expect(await ids("?q=Fatma&archived=1")).toContain(p.id);

      const detail = await get(request(`/api/patients/${p.id}`, { cookie: owner }), params(p.id));
      expect(detail.status).toBe(200);
      expect((await detail.json()).patient.deletedAt).not.toBeNull();

      // Archived records are read-only until restored, and cannot be archived twice.
      const edit = await update(
        request(`/api/patients/${p.id}`, { method: "PATCH", cookie: owner, body: { fullName: "X" } }),
        params(p.id),
      );
      expect(edit.status).toBe(404);
      const again = await archive(request(`/api/patients/${p.id}`, { method: "DELETE", cookie: owner }), params(p.id));
      expect(again.status).toBe(404);

      const back = await restore(request(`/api/patients/${p.id}/restore`, { method: "POST", cookie: owner }), params(p.id));
      expect(back.status).toBe(200);
      expect((await back.json()).patient).toMatchObject({ id: p.id, fullName: "Fatma Adel", deletedAt: null });
      expect(await ids("?q=Fatma")).toContain(p.id);

      const notArchived = await restore(
        request(`/api/patients/${p.id}/restore`, { method: "POST", cookie: owner }),
        params(p.id),
      );
      expect(notArchived.status).toBe(404);

      const actions = (await db.auditLog.findMany({ where: { tenantId, entityId: p.id } })).map((l) => l.action).sort();
      expect(actions).toEqual(["patient.archive", "patient.create", "patient.restore"]);
    });
  });

  describe("medical history", () => {
    it("de-duplicates the lists and records new diagnoses on the timeline", async () => {
      const p = await createVia({ fullName: "Sara Ibrahim" });
      const res = await updateHistory(
        request(`/api/patients/${p.id}/history`, {
          method: "PATCH",
          cookie: owner,
          body: {
            allergies: ["Penicillin", " penicillin", "", "Aspirin", "PENICILLIN"],
            chronicConditions: ["Asthma"],
            diagnoses: ["Mild persistent asthma"],
          },
        }),
        params(p.id),
      );
      expect(res.status).toBe(200);
      const { medicalHistory } = await res.json();
      expect(medicalHistory).toMatchObject({
        tenantId,
        patientId: p.id,
        allergies: ["Penicillin", "Aspirin"],
        chronicConditions: ["Asthma"],
        diagnoses: ["Mild persistent asthma"],
        surgeries: [],
      });

      const diagnosisEvents = () =>
        db.timelineEvent.findMany({ where: { tenantId, patientId: p.id, kind: "DIAGNOSIS" } });
      expect((await diagnosisEvents()).map((e) => e.title)).toEqual(["Mild persistent asthma"]);

      // A known diagnosis (in any casing) adds nothing; a new one is recorded once.
      // Lists that are not sent stay as they were.
      const second = await updateHistory(
        request(`/api/patients/${p.id}/history`, {
          method: "PATCH",
          cookie: owner,
          body: { diagnoses: ["MILD persistent asthma", "Allergic rhinitis", "allergic  rhinitis"] },
        }),
        params(p.id),
      );
      expect(second.status).toBe(200);
      const after = (await second.json()).medicalHistory;
      expect(after.diagnoses).toEqual(["MILD persistent asthma", "Allergic rhinitis"]);
      expect(after.allergies).toEqual(["Penicillin", "Aspirin"]);
      expect(after.chronicConditions).toEqual(["Asthma"]);
      expect((await diagnosisEvents()).map((e) => e.title).sort()).toEqual([
        "Allergic rhinitis",
        "Mild persistent asthma",
      ]);

      const logs = await db.auditLog.findMany({
        where: { tenantId, action: "patient.history.update", entityId: medicalHistory.id },
      });
      expect(logs).toHaveLength(2);
      expect(logs.map((l) => l.before)).toContainEqual(
        expect.objectContaining({ diagnoses: [], allergies: [] }),
      );
      expect(logs.map((l) => l.after)).toContainEqual(
        expect.objectContaining({ diagnoses: ["Mild persistent asthma"], allergies: ["Penicillin", "Aspirin"] }),
      );
    });

    it("bounds the lists", async () => {
      const p = await createVia({ fullName: "Bounded" });
      const tooMany = await updateHistory(
        request(`/api/patients/${p.id}/history`, {
          method: "PATCH",
          cookie: owner,
          body: { allergies: Array.from({ length: 51 }, (_, i) => `a${i}`), diagnoses: ["x".repeat(121)] },
        }),
        params(p.id),
      );
      expect(tooMany.status).toBe(422);
      const { fieldErrors } = (await tooMany.json()).issues;
      expect(Object.keys(fieldErrors).sort()).toEqual(["allergies", "diagnoses"]);
    });
  });

  describe("record", () => {
    it("aggregates history, medications, timeline, visits, consultations and upcoming appointments", async () => {
      const p = await createVia({ fullName: "Mohamed Saleh" });
      const doctor = await createUser({ tenantId, role: "DOCTOR", fullName: "Dr. Omar Fahmy" });
      const inAnHour = new Date(Date.now() + 60 * 60 * 1000);
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const halfHour = 30 * 60 * 1000;

      await db.appointment.createMany({
        data: [
          {
            tenantId,
            patientId: p.id,
            doctorId: doctor.id,
            startsAt: inAnHour,
            endsAt: new Date(inAnHour.getTime() + halfHour),
            reason: "Follow-up",
          },
          { tenantId, patientId: p.id, startsAt: yesterday, endsAt: new Date(yesterday.getTime() + halfHour), status: "COMPLETED" },
          { tenantId, patientId: p.id, startsAt: inAnHour, endsAt: new Date(inAnHour.getTime() + halfHour), status: "CANCELLED" },
        ],
      });
      await db.medication.createMany({
        data: [
          { tenantId, patientId: p.id, name: "Old med", active: false, stoppedAt: yesterday },
          { tenantId, patientId: p.id, name: "Metformin", dosage: "500mg", frequency: "Daily", startDate: yesterday },
        ],
      });
      const visit = await db.visit.create({ data: { tenantId, patientId: p.id, doctorId: doctor.id, summary: "Stable." } });
      await db.consultation.create({
        data: { tenantId, patientId: p.id, doctorId: doctor.id, status: "SIGNED", visitId: visit.id, summary: "Stable." },
      });
      await db.consultation.create({
        data: { tenantId, patientId: p.id, doctorId: doctor.id, status: "PENDING_REVIEW", summary: "Pending." },
      });
      await db.timelineEvent.create({
        data: { tenantId, patientId: p.id, kind: "VISIT", title: "Consultation signed", refId: visit.id, occurredAt: yesterday },
      });

      const res = await get(request(`/api/patients/${p.id}`, { cookie: owner }), params(p.id));
      expect(res.status).toBe(200);
      const { patient } = await res.json();
      expect(patient.id).toBe(p.id);
      expect(patient.medicalHistory).toMatchObject({ patientId: p.id });
      expect(patient.medications.map((m: { name: string }) => m.name)).toEqual(["Metformin", "Old med"]);
      expect(patient.upcomingAppointments).toHaveLength(1);
      expect(patient.upcomingAppointments[0]).toMatchObject({ reason: "Follow-up", doctor: { fullName: "Dr. Omar Fahmy" } });
      expect(patient.visits).toHaveLength(1);
      expect(patient.visits[0]).toMatchObject({
        id: visit.id,
        doctor: { fullName: "Dr. Omar Fahmy" },
        consultation: { status: "SIGNED" },
      });
      expect(patient.consultations.map((c: { status: string }) => c.status).sort()).toEqual(["PENDING_REVIEW", "SIGNED"]);
      expect(patient.consultations.every((c: { doctor: { fullName: string } | null }) => c.doctor?.fullName === "Dr. Omar Fahmy")).toBe(true);
      expect(patient.timeline.map((e: { kind: string }) => e.kind)).toEqual(["VISIT"]);
      expect(patient._count).toMatchObject({ appointments: 3, visits: 1, timeline: 1 });
    });

    it("404s for an unknown id", async () => {
      const res = await get(request("/api/patients/nope", { cookie: owner }), params("nope"));
      expect(res.status).toBe(404);
    });
  });

  describe("boundaries", () => {
    let p: PatientJson;

    beforeAll(async () => {
      p = await createVia({ fullName: "Boundary Case" });
    });

    it("another tenant gets 404 on read, update, archive, restore and history", async () => {
      const path = `/api/patients/${p.id}`;
      expect((await get(request(path, { cookie: foreign }), params(p.id))).status).toBe(404);
      expect(
        (await update(request(path, { method: "PATCH", cookie: foreign, body: { fullName: "Hijacked" } }), params(p.id)))
          .status,
      ).toBe(404);
      expect((await archive(request(path, { method: "DELETE", cookie: foreign }), params(p.id))).status).toBe(404);
      expect((await restore(request(`${path}/restore`, { method: "POST", cookie: foreign }), params(p.id))).status).toBe(404);
      expect(
        (
          await updateHistory(
            request(`${path}/history`, { method: "PATCH", cookie: foreign, body: { allergies: ["Latex"] } }),
            params(p.id),
          )
        ).status,
      ).toBe(404);

      const row = await db.patient.findUnique({ where: { id: p.id }, include: { medicalHistory: true } });
      expect(row).toMatchObject({ fullName: "Boundary Case", deletedAt: null });
      expect(row?.medicalHistory?.allergies).toEqual([]);
      expect((await listed("", foreign)).patients.map((x) => x.id)).not.toContain(p.id);
    });

    it("an assistant can read but not write", async () => {
      const path = `/api/patients/${p.id}`;
      expect((await listed("", assistant)).patients.map((x) => x.id)).toContain(p.id);
      expect((await get(request(path, { cookie: assistant }), params(p.id))).status).toBe(200);

      expect((await create(request("/api/patients", { cookie: assistant, body: { fullName: "Nope" } }))).status).toBe(403);
      expect(
        (await update(request(path, { method: "PATCH", cookie: assistant, body: { fullName: "Nope" } }), params(p.id)))
          .status,
      ).toBe(403);
      expect((await archive(request(path, { method: "DELETE", cookie: assistant }), params(p.id))).status).toBe(403);
      expect((await restore(request(`${path}/restore`, { method: "POST", cookie: assistant }), params(p.id))).status).toBe(403);
      expect(
        (
          await updateHistory(
            request(`${path}/history`, { method: "PATCH", cookie: assistant, body: { allergies: ["Latex"] } }),
            params(p.id),
          )
        ).status,
      ).toBe(403);
      expect((await db.patient.findUnique({ where: { id: p.id } }))?.fullName).toBe("Boundary Case");
    });

    it("every route requires a session", async () => {
      const path = `/api/patients/${p.id}`;
      expect((await get(request(path), params(p.id))).status).toBe(401);
      expect((await update(request(path, { method: "PATCH", body: { fullName: "X" } }), params(p.id))).status).toBe(401);
      expect((await archive(request(path, { method: "DELETE" }), params(p.id))).status).toBe(401);
      expect((await restore(request(`${path}/restore`, { method: "POST" }), params(p.id))).status).toBe(401);
      expect((await updateHistory(request(`${path}/history`, { method: "PATCH", body: {} }), params(p.id))).status).toBe(401);
    });
  });
});

/**
 * Phase 4A over the real route handlers and the test database: the clinic's
 * evidence library (doctors add sources, the owner with the clinician mark
 * approves and retires them; an approved source edited waits for approval
 * again), the evidence panel (clinicians only; answers only from approved
 * sources, each statement citing its passage; "no good source" said plainly;
 * the patient's facts sent without their name, phone, ID or date of birth,
 * and those taken out of the question; every question logged), each clinic's
 * library its own, and pregnancy on the record (women only, the day it was
 * checked) feeding the prescribing checks.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { GET as listSources, POST as createSource } from "@/app/api/evidence/sources/route";
import { GET as getSource, PATCH as patchSource } from "@/app/api/evidence/sources/[id]/route";
import { GET as contextRoute } from "@/app/api/evidence/context/route";
import { POST as ask } from "@/app/api/evidence/ask/route";
import { POST as external } from "@/app/api/evidence/external/route";
import { POST as createPatient } from "@/app/api/patients/route";
import { PATCH as updatePatient } from "@/app/api/patients/[id]/route";
import { POST as safetyCheck } from "@/app/api/consultations/[id]/safety-check/route";
import { NO_GOOD_SOURCE } from "@/modules/evidence/constants";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const DAY = 86_400_000;
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => ({ status: res.status, json: await res.json() });

const ISO_PROTOCOL = `Demo text for the tests.

# Monitoring during treatment
A pregnancy test every month for women who could become pregnant. Repeat lipids and liver tests after one month, then every three months.

# Do not combine
Do not prescribe tetracyclines (doxycycline, minocycline) with isotretinoin: together they raise the risk of benign intracranial hypertension.`;

describe.skipIf(!dbTestsEnabled)("the evidence library and panel", () => {
  const created: string[] = [];
  let a: string;
  let b: string;
  let owner: string;
  let ownerId: string;
  let aiLead: string;
  let doctor: string;
  let doctorId: string;
  let nurse: string;
  let reception: string;
  let doctorB: string;
  let mervat: string;

  const add = async (cookie: string, body: Record<string, unknown>) => json(await createSource(request("/api/evidence/sources", { cookie, body })));
  const patch = async (cookie: string, id: string, body: Record<string, unknown>) =>
    json(await patchSource(request(`/api/evidence/sources/${id}`, { method: "PATCH", cookie, body }), idParams(id)));
  const question = async (cookie: string, body: Record<string, unknown>) => json(await ask(request("/api/evidence/ask", { cookie, body })));

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `evidence-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `evidence-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    b = tenantB.id;
    created.push(a, b);
    const o = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Dr. Owner" });
    const lead = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "AI Lead", isClinician: false });
    const d = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Evidence" });
    const n = await createUser({ tenantId: a, role: "NURSE" });
    const r = await createUser({ tenantId: a, role: "RECEPTIONIST" });
    const db2 = await createUser({ tenantId: b, role: "DOCTOR" });
    ownerId = o.id;
    doctorId = d.id;
    owner = await sessionCookieFor(o.id);
    aiLead = await sessionCookieFor(lead.id);
    doctor = await sessionCookieFor(d.id);
    nurse = await sessionCookieFor(n.id);
    reception = await sessionCookieFor(r.id);
    doctorB = await sessionCookieFor(db2.id);
    mervat = (
      await db.patient.create({
        data: {
          tenantId: a,
          fullName: "Mervat Adel Hassan",
          gender: "FEMALE",
          dateOfBirth: new Date(Date.now() - 24.5 * 365.25 * DAY),
          phone: "+201001234567",
          whatsapp: "+201001234567",
          nationalId: "29801011234567",
          email: "mervat.adel@example.com",
          pregnancyStatus: "NOT_PREGNANT",
          pregnancyCheckedAt: new Date(Date.now() - 3 * DAY),
          medicalHistory: { create: { tenantId: a, allergies: ["Sulfa drugs"], chronicConditions: ["Acne vulgaris"] } },
          medications: { create: { tenantId: a, name: "Isotretinoin", dosage: "20 mg", frequency: "Once daily", active: true } },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  describe("the library", () => {
    it("doctors add sources, split into passages under their headings, waiting for the owner's approval", async () => {
      const res = await add(doctor, { title: "Isotretinoin: the clinic's protocol", kind: "PROTOCOL", publisher: "Test clinic", year: "2026", url: "https://example.org/iso", body: ISO_PROTOCOL });
      expect(res.status).toBe(201);
      expect(res.json.source).toMatchObject({ status: "DRAFT", statusLabel: "Waiting for approval", kindLabel: "Clinic protocol", year: 2026, createdBy: "Dr. Evidence", approvedBy: null, passages: 3 });
      expect(res.json.source.passageList.map((p: { heading: string | null }) => p.heading)).toEqual([null, "Monitoring during treatment", "Do not combine"]);
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "evidence.source.create", entityId: res.json.source.id } });
      expect(audit?.actorId).toBe(doctorId);
    });

    it("checks what is sent: a title, a kind, enough text, a web address only", async () => {
      const bad = await add(doctor, { title: "x", kind: "OPINION", body: "short", url: "javascript:alert(1)" });
      expect(bad.status).toBe(422);
      expect(Object.keys(bad.json.issues.fieldErrors).sort()).toEqual(["body", "kind", "title", "url"]);
      expect((await add(doctor, { title: "Ftp source", kind: "GUIDELINE", body: ISO_PROTOCOL, url: "ftp://example.org/x" })).status).toBe(422);
    });

    it("lets doctors and the owner read and write, the owner with the clinician mark approve; nobody else", async () => {
      const draft = (await add(doctor, { title: "Doxycycline sheet", kind: "DRUG_INFO", body: "# Who should not take it\nPregnancy and breastfeeding: tetracyclines stain the baby's teeth. Children under 8 years." })).json.source;
      expect((await listSources(request("/api/evidence/sources", { cookie: nurse }))).status).toBe(403);
      expect((await listSources(request("/api/evidence/sources", { cookie: reception }))).status).toBe(403);
      expect((await listSources(request("/api/evidence/sources"))).status).toBe(401);
      expect((await add(nurse, { title: "Nurse source", kind: "PROTOCOL", body: ISO_PROTOCOL })).status).toBe(403);
      expect((await listSources(request("/api/evidence/sources", { cookie: doctor }))).status).toBe(200);
      // A doctor writes but does not approve; the AI lead (an owner who is not a clinician) neither.
      expect((await patch(doctor, draft.id, { action: "approve" })).status).toBe(403);
      expect((await patch(aiLead, draft.id, { action: "approve" })).status).toBe(403);
      const approved = await patch(owner, draft.id, { action: "approve" });
      expect(approved.status).toBe(200);
      expect(approved.json.source).toMatchObject({ status: "APPROVED", approvedBy: "Dr. Owner" });
      expect((await patch(owner, draft.id, { action: "approve" })).json).toMatchObject({ error: "not_draft" });
      const audit = await db.auditLog.findFirst({ where: { tenantId: a, action: "evidence.source.approve", entityId: draft.id } });
      expect(audit?.actorId).toBe(ownerId);
    });

    it("sends an approved source back for approval when its text, title, publisher or year changes; not for its web address", async () => {
      const s = (await add(doctor, { title: "Peel aftercare", kind: "PROTOCOL", body: "# After the peel\nSunscreen every two hours for two weeks after a chemical peel." })).json.source;
      await patch(owner, s.id, { action: "approve" });
      const link = await patch(doctor, s.id, { url: "https://example.org/peel" });
      expect(link.json.source).toMatchObject({ status: "APPROVED", url: "https://example.org/peel" });
      const edited = await patch(doctor, s.id, { body: "# After the peel\nSunscreen every two hours for four weeks after a chemical peel." });
      expect(edited.json.source).toMatchObject({ status: "DRAFT", approvedBy: null, approvedAt: null });
      expect(edited.json.source.passageList[0].content).toContain("four weeks");
    });

    it("retires a source for good: not edited, not approved again", async () => {
      const s = (await add(doctor, { title: "Old protocol", kind: "PROTOCOL", body: ISO_PROTOCOL })).json.source;
      expect((await patch(doctor, s.id, { action: "retire" })).status).toBe(403);
      const retired = await patch(owner, s.id, { action: "retire" });
      expect(retired.json.source).toMatchObject({ status: "RETIRED", statusLabel: "Retired" });
      expect(retired.json.source.retiredAt).not.toBeNull();
      expect((await patch(doctor, s.id, { title: "New title" })).status).toBe(409);
      expect((await patch(owner, s.id, { action: "approve" })).status).toBe(409);
    });

    it("keeps each clinic's library its own", async () => {
      const s = (await add(doctor, { title: "Tenant A only", kind: "GUIDELINE", body: ISO_PROTOCOL })).json.source;
      expect((await getSource(request(`/api/evidence/sources/${s.id}`, { cookie: doctorB }), idParams(s.id))).status).toBe(404);
      expect((await patch(doctorB, s.id, { title: "Hijack" })).status).toBe(404);
      const list = await json(await listSources(request("/api/evidence/sources", { cookie: doctorB })));
      expect(list.json.sources).toEqual([]);
    });
  });

  describe("the panel", () => {
    it("is for clinicians only: doctors and the owner with the clinician mark", async () => {
      const body = { question: "Can doxycycline be given with isotretinoin?" };
      expect((await question(nurse, body)).status).toBe(403);
      expect((await question(reception, body)).status).toBe(403);
      expect((await question(aiLead, body)).status).toBe(403);
      expect((await ask(request("/api/evidence/ask", { body }))).status).toBe(401);
      expect((await contextRoute(request(`/api/evidence/context?patientId=${mervat}`, { cookie: nurse }))).status).toBe(403);
      expect((await question(doctor, body)).status).toBe(200);
      expect((await question(owner, body)).status).toBe(200);
    });

    it("answers only from approved sources, each statement citing its passage; a draft or retired source answers nothing", async () => {
      const tranexamic = "# Melasma\nOral tranexamic acid 250 mg twice a day for melasma, for three to six months; not with a history of thrombosis.";
      const draft = (await add(doctor, { title: "Tranexamic acid sheet", kind: "DRUG_INFO", body: tranexamic })).json.source;
      const q = { question: "What dose of tranexamic acid for melasma?" };
      const before = await question(doctor, q);
      expect(before.json).toMatchObject({ grounded: false, noGoodSource: NO_GOOD_SOURCE, statements: [], citations: [] });

      await patch(owner, draft.id, { action: "approve" });
      const after = await question(doctor, q);
      expect(after.json.grounded).toBe(true);
      expect(after.json.noGoodSource).toBeNull();
      expect(after.json.citations).toEqual([expect.objectContaining({ n: 1, sourceId: draft.id, title: "Tranexamic acid sheet", kindLabel: "Drug information", heading: "Melasma" })]);
      for (const s of after.json.statements) {
        expect(s.cites).toEqual([1]);
        expect(after.json.citations[0].passage).toContain(s.text);
      }
      expect(after.json.mode).toBe("library");

      await patch(owner, draft.id, { action: "retire" });
      expect((await question(doctor, q)).json.grounded).toBe(false);
    });

    it("sends the patient's facts without identifiers, takes them out of the question, and logs what left", async () => {
      const iso = (await add(doctor, { title: "Isotretinoin protocol (panel)", kind: "PROTOCOL", body: ISO_PROTOCOL })).json.source;
      await patch(owner, iso.id, { action: "approve" });

      const context = await json(await contextRoute(request(`/api/evidence/context?patientId=${mervat}`, { cookie: doctor })));
      expect(context.status).toBe(200);
      expect(context.json.context).toEqual([
        "Woman, 24 years",
        "Weight not recorded",
        expect.stringMatching(/^Pregnancy excluded on \d{1,2} \w{3} \d{4}$/),
        "Allergies: Sulfa drugs",
        "Medications: Isotretinoin 20 mg Once daily",
        "Conditions: Acne vulgaris",
      ]);

      const res = await question(doctor, {
        patientId: mervat,
        question: "Can Mervat Adel (01001234567, mervat.adel@example.com) take doxycycline with her isotretinoin?",
      });
      expect(res.status).toBe(200);
      expect(res.json.sentQuestion).toBe("Can the patient ([number], [email]) take doxycycline with her isotretinoin?");
      expect(res.json.grounded).toBe(true);
      expect(res.json.citations.some((c: { heading: string }) => c.heading === "Do not combine")).toBe(true);
      expect(res.json.context).toEqual(context.json.context);

      const run = await db.aiRun.findUniqueOrThrow({ where: { id: res.json.runId } });
      expect(run).toMatchObject({ tenantId: a, authorId: doctorId, kind: "evidence", status: "SUCCEEDED" });
      const logged = JSON.stringify([run.rawPrompt, run.generatedOutput, run.retrievedContext, run.citations]);
      for (const identifier of ["Mervat", "Adel", "Hassan", "1234567", "29801011234567", "example.com"]) expect(logged).not.toContain(identifier);
      expect(logged).toContain("Woman, 24 years");
    });

    it("a patient of another clinic is not found; another clinic's library never answers", async () => {
      expect((await question(doctorB, { patientId: mervat, question: "Can she take doxycycline?" })).status).toBe(404);
      expect((await contextRoute(request(`/api/evidence/context?patientId=${mervat}`, { cookie: doctorB }))).status).toBe(404);
      const res = await question(doctorB, { question: "Can doxycycline be given with isotretinoin?" });
      expect(res.json.grounded).toBe(false);
    });

    it("logs a question taken to OpenEvidence as it left: without the patient's name, numbers or e-mail; clinicians only", async () => {
      const body = { patientId: mervat, question: "Mervat Adel, 01001234567: isotretinoin and acne relapse after a first course?" };
      for (const cookie of [nurse, reception, aiLead]) expect((await external(request("/api/evidence/external", { cookie, body }))).status).toBe(403);
      const res = await json(await external(request("/api/evidence/external", { cookie: doctor, body })));
      expect(res.status).toBe(200);
      expect(res.json.sentQuestion).toBe("the patient, [number]: isotretinoin and acne relapse after a first course?");
      const row = await db.auditLog.findFirstOrThrow({ where: { tenantId: a, action: "evidence.openevidence" }, orderBy: { createdAt: "desc" } });
      expect(row).toMatchObject({ actorId: doctorId, entityId: mervat });
      expect(row.after).toEqual({ question: res.json.sentQuestion, service: "OpenEvidence" });
      expect((await external(request("/api/evidence/external", { cookie: doctorB, body }))).status).toBe(404);
    });

    it("validates the question", async () => {
      expect((await question(doctor, { question: "" })).status).toBe(422);
      expect((await question(doctor, { question: "x".repeat(1_001) })).status).toBe(422);
    });
  });

  describe("pregnancy on the record", () => {
    it("is recorded for women, on the day it was checked (not ahead), and cleared when the record says male", async () => {
      expect((await createPatient(request("/api/patients", { cookie: owner, body: { fullName: "Male Patient", gender: "MALE", phone: "+201005550001", pregnancyStatus: "NOT_PREGNANT" } }))).status).toBe(422);
      const created = await json(await createPatient(request("/api/patients", { cookie: owner, body: { fullName: "Female Patient", gender: "FEMALE", phone: "+201005550002", pregnancyStatus: "NOT_PREGNANT" } })));
      expect(created.status).toBe(201);
      const id = created.json.patient.id;
      const row = await db.patient.findUniqueOrThrow({ where: { id } });
      expect(row.pregnancyStatus).toBe("NOT_PREGNANT");
      expect(Date.now() - row.pregnancyCheckedAt!.getTime()).toBeLessThan(60_000);

      const ahead = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
      const future = await json(await updatePatient(request(`/api/patients/${id}`, { method: "PATCH", cookie: owner, body: { pregnancyStatus: "PREGNANT", pregnancyCheckedOn: ahead } }), idParams(id)));
      expect(future.status).toBe(422);
      expect(future.json.issues.fieldErrors.pregnancyCheckedOn).toBeDefined();

      const day = new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10);
      expect((await updatePatient(request(`/api/patients/${id}`, { method: "PATCH", cookie: owner, body: { pregnancyStatus: "PREGNANT", pregnancyCheckedOn: day } }), idParams(id))).status).toBe(200);
      expect((await db.patient.findUniqueOrThrow({ where: { id } })).pregnancyStatus).toBe("PREGNANT");

      await updatePatient(request(`/api/patients/${id}`, { method: "PATCH", cookie: owner, body: { gender: "MALE" } }), idParams(id));
      expect(await db.patient.findUniqueOrThrow({ where: { id }, select: { pregnancyStatus: true, pregnancyCheckedAt: true } })).toEqual({ pregnancyStatus: null, pregnancyCheckedAt: null });
    });

    it("records the weight with its day (not ahead), and checks isotretinoin per kilogram against it", async () => {
      const created = await json(await createPatient(request("/api/patients", { cookie: owner, body: { fullName: "Weighed Patient", gender: "MALE", phone: "+201005550003", weightKg: "62,5" } })));
      expect(created.status).toBe(201);
      const id = created.json.patient.id;
      const row = await db.patient.findUniqueOrThrow({ where: { id } });
      expect(row.weightKg).toBe(62.5);
      expect(Date.now() - row.weighedAt!.getTime()).toBeLessThan(60_000);
      const patch = (body: Record<string, unknown>) => updatePatient(request(`/api/patients/${id}`, { method: "PATCH", cookie: owner, body }), idParams(id));
      for (const weightKg of [0, 500, "heavy"]) expect((await patch({ weightKg })).status).toBe(422);
      expect((await patch({ weightKg: 70, weighedOn: new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10) })).status).toBe(422);

      expect((await patch({ weightKg: 50 })).status).toBe(200);
      const c = await db.consultation.create({
        data: { tenantId: a, patientId: id, doctorId, status: "PENDING_REVIEW", transcript: "Doctor: prescription discussed today.", extraction: { symptoms: [], diagnoses: [], medications: [], tests: [], followUps: [] }, summary: "" },
      });
      const res = await safetyCheck(request(`/api/consultations/${c.id}/safety-check`, { cookie: doctor, body: { medications: [{ name: "Isotretinoin", dosage: "60 mg", frequency: "Once daily" }] } }), idParams(c.id));
      const checked = await res.json();
      expect(checked.findings.map((f: { severity: string; rule: string }) => `${f.severity}:${f.rule}`)).toEqual(["warn:dose.per-kg"]);
      expect(checked.context).toMatchObject({ weightKg: 50 });

      expect((await patch({ weightKg: null })).status).toBe(200);
      expect(await db.patient.findUniqueOrThrow({ where: { id }, select: { weightKg: true, weighedAt: true } })).toEqual({ weightKg: null, weighedAt: null });
    });

    it("feeds the prescribing checks: excluded recently, isotretinoin warns about contraception; too long ago, it stops; pregnant, doxycycline stops", async () => {
      const woman = async (status: "PREGNANT" | "NOT_PREGNANT" | null, daysAgo: number) =>
        (
          await db.patient.create({
            data: { tenantId: a, fullName: `Woman ${status} ${daysAgo}`, gender: "FEMALE", dateOfBirth: new Date(Date.now() - 26 * 365.25 * DAY), pregnancyStatus: status, pregnancyCheckedAt: status ? new Date(Date.now() - daysAgo * DAY) : null },
          })
        ).id;
      const check = async (patientId: string, name: string) => {
        const c = await db.consultation.create({
          data: { tenantId: a, patientId, doctorId, status: "PENDING_REVIEW", transcript: "Doctor: prescription discussed today.", extraction: { symptoms: [], diagnoses: [], medications: [], tests: [], followUps: [] }, summary: "" },
        });
        const res = await safetyCheck(request(`/api/consultations/${c.id}/safety-check`, { cookie: doctor, body: { medications: [{ name, dosage: "20 mg" }] } }), idParams(c.id));
        return ((await res.json()).findings as { rule: string; severity: string }[]).filter((f) => f.rule.startsWith("pregnancy.")).map((f) => `${f.severity}:${f.rule}`);
      };
      expect(await check(await woman("NOT_PREGNANT", 5), "Isotretinoin")).toEqual(["warn:pregnancy.contraception"]);
      expect(await check(await woman("NOT_PREGNANT", 45), "Isotretinoin")).toEqual(["stop:pregnancy.teratogen"]);
      expect(await check(await woman(null, 0), "Isotretinoin")).toEqual(["stop:pregnancy.teratogen"]);
      expect(await check(await woman("PREGNANT", 60), "Doxycycline")).toEqual(["stop:pregnancy.pregnant"]);
    });
  });
});

/**
 * RAG ingestion and retrieval against the test database, using the
 * deterministic `echo` embedding provider. Covers idempotent upserts,
 * retrieval, tenant isolation, removal and the assistant route end to end.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { answerWithRag, retrieve } from "@/lib/ai/rag";
import {
  flushBackgroundIngestion,
  ingestConsultation,
  ingestConversation,
  ingestInBackground,
  ingestPatient,
  ingestVisit,
  reindexTenant,
  removePatientKnowledge,
} from "@/modules/knowledge/ingest";
import { POST as assistant } from "@/app/api/assistant/route";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

async function rowsFor(tenantId: string, where: Record<string, unknown> = {}) {
  return db.knowledgeEmbedding.findMany({ where: { tenantId, ...where }, orderBy: [{ source: "asc" }, { chunkIndex: "asc" }] });
}

async function missingEmbeddings(tenantId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count FROM knowledge_embeddings WHERE "tenantId" = ${tenantId} AND embedding IS NULL
  `;
  return row?.count ?? 0;
}

describe.skipIf(!dbTestsEnabled)("knowledge ingestion + retrieval", () => {
  const created: string[] = [];
  let a: { id: string };
  let b: { id: string };
  let ahmedId: string;
  let saraId: string;
  let bPatientId: string;
  let doctorId: string;
  let doctorCookie: string;

  beforeAll(async () => {
    a = await createTenant({ slug: `rag-a-${Date.now().toString(36)}` });
    b = await createTenant({ slug: `rag-b-${Date.now().toString(36)}` });
    created.push(a.id, b.id);

    const doctor = await createUser({ tenantId: a.id, role: "DOCTOR", fullName: "Dr. Omar Fahmy" });
    doctorId = doctor.id;
    doctorCookie = await sessionCookieFor(doctor.id);

    ahmedId = (
      await db.patient.create({
        data: {
          tenantId: a.id,
          fullName: "Ahmed Mahmoud",
          gender: "MALE",
          dateOfBirth: new Date("1970-01-10T00:00:00Z"),
          language: "ar",
          tags: ["hair-transplant"],
          notes: "Prefers morning appointments.",
          medicalHistory: {
            create: {
              tenantId: a.id,
              chronicConditions: ["Hypertension"],
              diagnoses: ["Essential hypertension", "Androgenetic alopecia"],
              allergies: ["Penicillin"],
            },
          },
          medications: {
            create: [
              { tenantId: a.id, name: "Amlodipine", dosage: "5 mg", frequency: "once daily", startDate: new Date("2026-01-10T00:00:00Z") },
              { tenantId: a.id, name: "Finasteride", dosage: "1 mg", frequency: "once daily" },
            ],
          },
        },
      })
    ).id;

    saraId = (
      await db.patient.create({
        data: {
          tenantId: a.id,
          fullName: "Sara Ibrahim",
          gender: "FEMALE",
          medicalHistory: { create: { tenantId: a.id, diagnoses: ["Acne vulgaris"], allergies: [] } },
          medications: { create: [{ tenantId: a.id, name: "Isotretinoin", dosage: "20 mg", frequency: "once daily" }] },
        },
      })
    ).id;

    bPatientId = (
      await db.patient.create({
        data: {
          tenantId: b.id,
          fullName: "Mohamed Saleh",
          medicalHistory: { create: { tenantId: b.id, diagnoses: ["Essential hypertension"] } },
          medications: { create: [{ tenantId: b.id, name: "Amlodipine", dosage: "10 mg", frequency: "once daily" }] },
        },
      })
    ).id;
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("ingests a patient into history (DIAGNOSIS) and medication (MEDICATION) chunks with embeddings", async () => {
    const results = await ingestPatient(a.id, ahmedId);
    expect(results.map((r) => r.source)).toEqual(["DIAGNOSIS", "MEDICATION"]);
    for (const r of results) {
      expect(r.chunks).toBeGreaterThanOrEqual(1);
      expect(r.embedded).toBe(r.chunks);
      expect(r.skipped).toBe(0);
    }

    const rows = await rowsFor(a.id, { patientId: ahmedId });
    expect(rows).toHaveLength(results.reduce((n, r) => n + r.chunks, 0));
    for (const row of rows) {
      expect(row.refId).toBe(ahmedId);
      expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.metadata).toMatchObject({ model: "echo-embed-1", patientName: "Ahmed Mahmoud" });
    }
    const history = rows.find((r) => r.source === "DIAGNOSIS")!;
    expect(history.content).toContain("Essential hypertension");
    expect(history.content).toContain("Penicillin");
    expect(history.content).toContain("Amlodipine 5 mg once daily");
    expect(history.metadata).toMatchObject({ kind: "patient_history", title: "Profile & medical history" });
    const meds = rows.find((r) => r.source === "MEDICATION")!;
    expect(meds.content).toContain("Finasteride 1 mg once daily");
    expect(await missingEmbeddings(a.id)).toBe(0);
  });

  it("is idempotent: an unchanged patient embeds nothing on the second run", async () => {
    const before = await rowsFor(a.id, { patientId: ahmedId });
    const results = await ingestPatient(a.id, ahmedId);
    for (const r of results) {
      expect(r.embedded).toBe(0);
      expect(r.skipped).toBe(r.chunks);
      expect(r.deleted).toBe(0);
    }
    const after = await rowsFor(a.id, { patientId: ahmedId });
    expect(after.map((r) => [r.id, r.contentHash])).toEqual(before.map((r) => [r.id, r.contentHash]));
  });

  it("re-embeds only the document whose content changed", async () => {
    await db.medicalHistory.update({
      where: { patientId: ahmedId },
      data: { diagnoses: ["Essential hypertension", "Androgenetic alopecia", "Seborrheic dermatitis"] },
    });
    const results = await ingestPatient(a.id, ahmedId);
    const history = results.find((r) => r.source === "DIAGNOSIS")!;
    const meds = results.find((r) => r.source === "MEDICATION")!;
    expect(history.embedded).toBeGreaterThanOrEqual(1);
    expect(meds.embedded).toBe(0);
    const row = (await rowsFor(a.id, { patientId: ahmedId, source: "DIAGNOSIS" }))[0]!;
    expect(row.content).toContain("Seborrheic dermatitis");
    expect(await missingEmbeddings(a.id)).toBe(0);
  });

  it("retrieves the patient's chunk for a query containing the diagnosis, with scores in [0,1]", async () => {
    await ingestPatient(a.id, saraId);
    const chunks = await retrieve(a.id, "Which patient has essential hypertension?", { topK: 5 });
    expect(chunks.length).toBeGreaterThan(0);
    const hit = chunks.find((c) => c.patientId === ahmedId && c.source === "DIAGNOSIS");
    expect(hit).toBeDefined();
    expect(hit!.lexicalScore).toBeGreaterThan(0);
    expect(hit!.metadata?.title).toBe("Profile & medical history");
    for (const c of chunks) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
    expect(chunks[0]!.patientId).toBe(ahmedId);
  });

  it("finds a drug name even with a typo (trigram similarity)", async () => {
    const chunks = await retrieve(a.id, "who takes isotretinoine", { topK: 5 });
    expect(chunks[0]).toMatchObject({ patientId: saraId });
  });

  it("restricts retrieval to one patient when a patientId is given", async () => {
    const chunks = await retrieve(a.id, "essential hypertension amlodipine", { topK: 5, patientId: saraId });
    expect(chunks.every((c) => c.patientId === saraId)).toBe(true);
  });

  it("never returns another tenant's chunks", async () => {
    await ingestPatient(b.id, bPatientId);
    const fromB = await retrieve(b.id, "essential hypertension amlodipine Ahmed Mahmoud", { topK: 10 });
    expect(fromB.length).toBeGreaterThan(0);
    expect(fromB.every((c) => c.patientId === bPatientId)).toBe(true);
    expect(fromB.some((c) => c.content.includes("Ahmed"))).toBe(false);

    const fromA = await retrieve(a.id, "Mohamed Saleh amlodipine 10 mg", { topK: 10 });
    expect(fromA.every((c) => c.patientId !== bPatientId)).toBe(true);
    expect(fromA.some((c) => c.content.includes("Mohamed Saleh"))).toBe(false);

    // Asking tenant A for tenant B's patient id yields nothing, not B's data.
    expect(await retrieve(a.id, "amlodipine", { topK: 10, patientId: bPatientId })).toEqual([]);
  });

  it("indexes visits, signed consultations and conversations, but never unsigned consultations", async () => {
    const visit = await db.visit.create({
      data: {
        tenantId: a.id,
        patientId: ahmedId,
        doctorId,
        summary: "Follow-up after FUE hair transplant; 2,400 grafts healing well.",
        notes: "Continue finasteride. Review in 3 months.",
        transcript: "Doctor: How is the donor area? Patient: Much better, no pain.",
      },
    });
    const visitResult = await ingestVisit(a.id, visit.id);
    expect(visitResult).toMatchObject({ source: "VISIT_NOTE", refId: visit.id, embedded: visitResult.chunks });
    const visitRow = (await rowsFor(a.id, { source: "VISIT_NOTE", refId: visit.id }))[0]!;
    expect(visitRow.patientId).toBe(ahmedId);
    expect(visitRow.content).toContain("Dr. Omar Fahmy");
    expect(visitRow.content).toContain("2,400 grafts");
    expect(visitRow.metadata).toMatchObject({ kind: "visit" });

    const pending = await db.consultation.create({
      data: { tenantId: a.id, patientId: ahmedId, status: "PENDING_REVIEW", transcript: "unsigned draft", summary: "draft" },
    });
    expect(await ingestConsultation(a.id, pending.id)).toMatchObject({ chunks: 0, embedded: 0, deleted: 0 });
    expect(await rowsFor(a.id, { source: "TRANSCRIPT", refId: pending.id })).toEqual([]);

    const signed = await db.consultation.create({
      data: {
        tenantId: a.id,
        patientId: ahmedId,
        status: "SIGNED",
        reviewedAt: new Date("2026-10-01T10:00:00Z"),
        transcript: "Patient reports itching of the scalp after the procedure.",
        summary: "Post-operative scalp irritation; topical steroid advised.",
        extraction: {
          symptoms: ["scalp itching"],
          diagnoses: ["Post-operative irritation"],
          medications: [{ name: "Hydrocortisone cream", dosage: "1%", frequency: "twice daily" }],
          tests: [],
          followUps: ["Review in 2 weeks"],
        },
      },
    });
    const consultationResult = await ingestConsultation(a.id, signed.id);
    expect(consultationResult.chunks).toBeGreaterThanOrEqual(1);
    const consultationRow = (await rowsFor(a.id, { source: "TRANSCRIPT", refId: signed.id }))[0]!;
    expect(consultationRow.content).toContain("Hydrocortisone cream (1%, twice daily)");
    expect(consultationRow.content).toContain("Review in 2 weeks");
    expect(consultationRow.content).toContain("itching of the scalp");

    const conversation = await db.conversation.create({
      data: {
        tenantId: a.id,
        patientId: ahmedId,
        channel: "WHATSAPP",
        locale: "ar",
        summary: "Patient asked to reschedule the PRP session to next week.",
      },
    });
    const conversationResult = await ingestConversation(a.id, conversation.id);
    expect(conversationResult.chunks).toBe(1);
    const conversationRow = (await rowsFor(a.id, { source: "CONVERSATION", refId: conversation.id }))[0]!;
    expect(conversationRow.content).toContain("WhatsApp conversation");
    expect(conversationRow.content).toContain("PRP session");

    const empty = await db.conversation.create({ data: { tenantId: a.id, channel: "VOICE" } });
    expect(await ingestConversation(a.id, empty.id)).toMatchObject({ chunks: 0 });

    const hits = await retrieve(a.id, "FUE hair transplant grafts", { topK: 3 });
    expect(hits[0]).toMatchObject({ source: "VISIT_NOTE", refId: visit.id });
    expect(await missingEmbeddings(a.id)).toBe(0);
  });

  it("re-indexes a whole tenant, skipping unchanged chunks and reporting counts", async () => {
    const lines: string[] = [];
    const counts = await reindexTenant(a.id, { log: (line) => lines.push(line) });
    expect(counts).toMatchObject({ patients: 2, visits: 1, consultations: 1, conversations: 2, errors: 0 });
    expect(counts.chunks.embedded).toBe(0);
    expect(counts.chunks.skipped).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith("done:"))).toBe(true);
  });

  it("answers through the route: grounded, cited and linked to the patient, and audited compactly", async () => {
    const res = await assistant(request("/api/assistant", { cookie: doctorCookie, body: { query: "What is Ahmed Mahmoud's diagnosis and which medication is he taking?" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grounded).toBe(true);
    expect(body.confidence).toBeGreaterThan(0.35);
    expect(body.provider).toBe("echo");
    expect(body.answer).toMatch(/\[\d+\]/);
    expect(body.answer).toContain("Essential hypertension");
    expect(typeof body.latencyMs).toBe("number");
    const linked = body.citations.find((c: { patientId: string | null }) => c.patientId === ahmedId);
    expect(linked).toMatchObject({ patientName: "Ahmed Mahmoud", href: `/dashboard/patients/${ahmedId}` });
    expect(linked.snippet.length).toBeGreaterThan(0);

    const run = await db.aiRun.findFirst({ where: { tenantId: a.id, kind: "assistant_chat" }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.confidenceScore).toBe(body.confidence);
    const context = run?.retrievedContext as { id: string; source: string; refId: string; score: number; content?: string }[];
    expect(context.length).toBeGreaterThan(0);
    expect(context[0]).toEqual({ id: context[0]!.id, source: context[0]!.source, refId: context[0]!.refId, score: context[0]!.score });
  });

  it("scopes the route to a patient and rejects another tenant's patient id", async () => {
    const scoped = await assistant(
      request("/api/assistant", { cookie: doctorCookie, body: { query: "Any allergies before a procedure?", patientId: saraId } }),
    );
    expect(scoped.status).toBe(200);
    const body = await scoped.json();
    expect(body.citations.every((c: { patientId: string | null }) => c.patientId === saraId)).toBe(true);

    const foreign = await assistant(request("/api/assistant", { cookie: doctorCookie, body: { query: "Hypertension?", patientId: bPatientId } }));
    expect(foreign.status).toBe(404);

    const tooLong = await assistant(request("/api/assistant", { cookie: doctorCookie, body: { query: "x".repeat(2001) } }));
    expect(tooLong.status).toBe(422);
  });

  it("reports no matching records for a question nothing in the store answers", async () => {
    const answer = await answerWithRag(a.id, "zzqx qwvz plorth");
    expect(answer.grounded).toBe(false);
    expect(answer.confidence).toBe(0);
    expect(answer.citations).toEqual([]);
    expect(answer.answer).toMatch(/no matching records/i);
  });

  it("removes all of a patient's knowledge on archive", async () => {
    expect((await rowsFor(a.id, { patientId: ahmedId })).length).toBeGreaterThan(2);
    const deleted = await removePatientKnowledge(a.id, ahmedId);
    expect(deleted).toBeGreaterThan(2);
    expect(await rowsFor(a.id, { patientId: ahmedId })).toEqual([]);
    expect((await rowsFor(a.id, { patientId: saraId })).length).toBeGreaterThan(0);
    expect(await removePatientKnowledge(a.id, ahmedId)).toBe(0);
  });

  it("runs ingestion in the background and logs failures instead of throwing", async () => {
    ingestInBackground({ kind: "patient", tenantId: a.id, id: ahmedId });
    ingestInBackground({ kind: "patient", tenantId: a.id, id: ahmedId }); // serialised with the first
    ingestInBackground({ kind: "visit", tenantId: a.id, id: "does-not-exist" }); // no-op, no throw
    await flushBackgroundIngestion();
    expect((await rowsFor(a.id, { patientId: ahmedId })).length).toBeGreaterThanOrEqual(2);
  });

  it("drops the knowledge of a patient that has been archived on the next ingest", async () => {
    await db.patient.update({ where: { id: saraId }, data: { deletedAt: new Date() } });
    const results = await ingestPatient(a.id, saraId);
    expect(results.every((r) => r.chunks === 0)).toBe(true);
    expect(await rowsFor(a.id, { patientId: saraId })).toEqual([]);
  });
});

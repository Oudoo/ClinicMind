/**
 * Phase 4, log and review, over the real route handlers and the test
 * database: the doctor who asked rates the answer (nobody else), every AI
 * run, rating and safety override is kept for good (the database refuses an
 * edit or a deletion), and the owner's monthly review counts the month's
 * questions, answers, ratings, what nothing answered, the sources cited, the
 * OpenEvidence hand-offs and the overrides; on the first of the month the
 * clinician owners are told it is ready, once.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { zonedTimeToUtc } from "@/lib/time";
import { POST as ask } from "@/app/api/evidence/ask/route";
import { POST as createSource } from "@/app/api/evidence/sources/route";
import { PATCH as patchSource } from "@/app/api/evidence/sources/[id]/route";
import { POST as rate } from "@/app/api/ai-runs/[id]/feedback/route";
import { GET as reviewRoute } from "@/app/api/ai-review/route";
import { sendMonthlyReview } from "@/modules/ai-log/review";
import { jobs } from "@/modules/ai-log/jobs";
import { createTenant, createUser, dbTestsEnabled, deleteTenants, request, runAsSystem, sessionCookieFor } from "@/test/db";

runAsSystem();

const TZ = "Africa/Cairo";
const json = async (res: Response) => ({ status: res.status, json: await res.json() });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!dbTestsEnabled)("the AI log and the monthly review", () => {
  const created: string[] = [];
  let a: string;
  let ownerId: string;
  let owner: string;
  let aiLeadId: string;
  let aiLead: string;
  let doctorId: string;
  let doctor: string;
  let doctor2: string;
  let nurse: string;
  let otherOwner: string;

  /** A run as the evidence panel or the assistant logs it, on a given day. */
  const run = (data: { kind: string; authorId: string; createdAt: Date; question: string; cited?: string[]; status?: "SUCCEEDED" | "FAILED"; tenantId?: string }) =>
    db.aiRun.create({
      data: {
        tenantId: data.tenantId ?? a,
        authorId: data.authorId,
        kind: data.kind,
        provider: "clinicmind",
        model: "library-quotes",
        rawPrompt: data.kind === "evidence" ? `Question: ${data.question}` : data.question,
        retrievedContext: data.kind === "evidence" ? { question: data.question } : [],
        generatedOutput: data.cited?.length ? "Quoted answer [1]." : "No good source in the clinic's library answers this question.",
        citations: (data.cited ?? []).map((title, i) => ({ n: i + 1, title })),
        status: data.status ?? "SUCCEEDED",
        createdAt: data.createdAt,
      },
    });

  beforeAll(async () => {
    const tenantA = await createTenant({ slug: `ai-log-${Date.now().toString(36)}` });
    const tenantB = await createTenant({ slug: `ai-log-b-${Date.now().toString(36)}` });
    a = tenantA.id;
    created.push(a, tenantB.id);
    const o = await createUser({ tenantId: a, role: "CLINIC_OWNER", fullName: "Dr. Owner" });
    const lead = await createUser({ tenantId: a, role: "CLINIC_OWNER", isClinician: false, fullName: "AI Lead" });
    const d = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Asker" });
    const d2 = await createUser({ tenantId: a, role: "DOCTOR", fullName: "Dr. Other" });
    const n = await createUser({ tenantId: a, role: "NURSE" });
    const ob = await createUser({ tenantId: tenantB.id, role: "CLINIC_OWNER" });
    ownerId = o.id;
    aiLeadId = lead.id;
    doctorId = d.id;
    owner = await sessionCookieFor(o.id);
    aiLead = await sessionCookieFor(lead.id);
    doctor = await sessionCookieFor(d.id);
    doctor2 = await sessionCookieFor(d2.id);
    nurse = await sessionCookieFor(n.id);
    otherOwner = await sessionCookieFor(ob.id);
  });

  afterAll(async () => {
    await deleteTenants(created);
  });

  it("the doctor who asked rates the answer, with what was wrong; nobody else does", async () => {
    const source = (await json(await createSource(request("/api/evidence/sources", { cookie: doctor, body: { title: "Doxycycline sheet", kind: "DRUG_INFO", body: "# Who should not take it\nPatients taking isotretinoin: together they raise the risk of benign intracranial hypertension." } })))).json.source;
    await patchSource(request(`/api/evidence/sources/${source.id}`, { method: "PATCH", cookie: owner, body: { action: "approve" } }), idParams(source.id));
    const answer = (await json(await ask(request("/api/evidence/ask", { cookie: doctor, body: { question: "Can doxycycline be given with isotretinoin?" } })))).json;
    expect(answer.grounded).toBe(true);
    const runId = answer.runId as string;
    // The cited words are kept with the run.
    const logged = await db.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(logged.citations).toEqual([expect.objectContaining({ n: 1, title: "Doxycycline sheet", heading: "Who should not take it", passage: expect.stringContaining("intracranial hypertension") })]);
    expect(logged.retrievedContext).toMatchObject({ question: "Can doxycycline be given with isotretinoin?" });

    const post = (cookie: string, body: unknown, id = runId) => rate(request(`/api/ai-runs/${id}/feedback`, { cookie, body }), idParams(id));
    expect((await post(doctor2, { helpful: true })).status).toBe(403);
    expect((await post(nurse, { helpful: true })).status).toBe(403);
    expect((await post(otherOwner, { helpful: true })).status).toBe(404);
    expect((await post(doctor, { helpful: "yes" })).status).toBe(422);
    expect((await post(doctor, { helpful: false, comment: "x".repeat(1_001) })).status).toBe(422);
    const res = await json(await post(doctor, { helpful: false, comment: "It should say to stop doxycycline first." }));
    expect(res.status).toBe(201);
    expect(res.json.feedback).toMatchObject({ helpful: false, comment: "It should say to stop doxycycline first." });
    // A run that answers no question is not rated.
    const extraction = await db.aiRun.create({ data: { tenantId: a, authorId: doctorId, kind: "extraction", provider: "echo", model: "echo-1", rawPrompt: "transcript", status: "SUCCEEDED" } });
    expect((await json(await post(doctor, { helpful: true }, extraction.id))).json.error).toBe("not_a_question");
  });

  it("keeps every run, rating and override for good: the database refuses an edit or a deletion", async () => {
    const r = await run({ kind: "assistant_chat", authorId: doctorId, createdAt: new Date(), question: "Which patients are on doxycycline?" });
    const f = await db.aiFeedback.create({ data: { tenantId: a, runId: r.id, userId: doctorId, helpful: true } });
    const patient = await db.patient.create({ data: { tenantId: a, fullName: "Override Patient" } });
    const o = await db.safetyOverride.create({ data: { tenantId: a, patientId: patient.id, userId: doctorId, rule: "pregnancy.teratogen", severity: "stop", medication: "Isotretinoin", message: "m", reason: "r" } });
    await expect(db.aiRun.update({ where: { id: r.id }, data: { generatedOutput: "rewritten" } })).rejects.toThrow(/kept for good/);
    await expect(db.aiRun.delete({ where: { id: r.id } })).rejects.toThrow(/kept for good/);
    await expect(db.aiFeedback.update({ where: { id: f.id }, data: { helpful: false } })).rejects.toThrow(/kept for good/);
    await expect(db.aiFeedback.delete({ where: { id: f.id } })).rejects.toThrow(/kept for good/);
    await expect(db.safetyOverride.update({ where: { id: o.id }, data: { reason: "changed" } })).rejects.toThrow(/kept for good/);
    await expect(db.safetyOverride.delete({ where: { id: o.id } })).rejects.toThrow(/kept for good/);
  });

  it("reviews a month for the owner: questions, answers, ratings, what nothing answered, sources, OpenEvidence and overrides", async () => {
    const sept = (day: number, hour = 11) => zonedTimeToUtc({ year: 2026, month: 9, day, hour, minute: 0 }, TZ);
    const answered = await run({ kind: "evidence", authorId: doctorId, createdAt: sept(3), question: "Can doxycycline be given with isotretinoin?", cited: ["Isotretinoin protocol", "Doxycycline sheet"] });
    await run({ kind: "evidence", authorId: doctorId, createdAt: sept(4), question: "What dose of tranexamic acid for melasma?" });
    const chat = await run({ kind: "assistant_chat", authorId: ownerId, createdAt: sept(10), question: "Which patients are allergic to penicillin?", cited: ["record"] });
    await run({ kind: "assistant_cohort", authorId: doctorId, createdAt: sept(12), question: "Patients on isotretinoin", status: "FAILED" });
    await run({ kind: "evidence", authorId: doctorId, createdAt: sept(30, 23), question: "Late September", cited: ["Isotretinoin protocol"] });
    await run({ kind: "evidence", authorId: doctorId, createdAt: zonedTimeToUtc({ year: 2026, month: 8, day: 20, hour: 11, minute: 0 }, TZ), question: "August" });
    await run({ kind: "extraction", authorId: doctorId, createdAt: sept(5), question: "not a question" });
    // A rating changed: the latest counts.
    await db.aiFeedback.create({ data: { tenantId: a, runId: answered.id, userId: doctorId, helpful: true, createdAt: sept(3, 12) } });
    await db.aiFeedback.create({ data: { tenantId: a, runId: answered.id, userId: doctorId, helpful: false, comment: "Missed the pregnancy test.", createdAt: sept(3, 13) } });
    await db.aiFeedback.create({ data: { tenantId: a, runId: chat.id, userId: ownerId, helpful: true, createdAt: sept(10, 12) } });
    await db.auditLog.create({ data: { tenantId: a, actorId: doctorId, action: "evidence.openevidence", entity: "Patient", after: { question: "q" }, createdAt: sept(6) } });
    const patient = await db.patient.create({ data: { tenantId: a, fullName: "September Patient" } });
    for (const [rule, severity] of [["pregnancy.teratogen", "stop"], ["pregnancy.caution", "warn"], ["pregnancy.caution", "warn"]] as const) {
      await db.safetyOverride.create({ data: { tenantId: a, patientId: patient.id, userId: doctorId, rule, severity, message: "m", reason: "r", createdAt: sept(7) } });
    }

    expect((await reviewRoute(request("/api/ai-review?month=2026-09", { cookie: doctor }))).status).toBe(403);
    expect((await reviewRoute(request("/api/ai-review?month=2026-09", { cookie: aiLead }))).status).toBe(403);
    const res = await json(await reviewRoute(request("/api/ai-review?month=2026-09", { cookie: owner })));
    expect(res.status).toBe(200);
    const r = res.json;
    expect(r).toMatchObject({ month: "2026-09", label: "September 2026" });
    expect(r.questions).toEqual({ total: 5, evidence: 3, assistant: 2, answered: 3, unanswered: 1, failed: 1, external: 1, previousTotal: 1 });
    expect(r.ratings).toEqual({ rated: 2, helpful: 1, notHelpful: 1 });
    expect(r.byDoctor).toEqual([
      { name: "Dr. Asker", questions: 4, answered: 2, helpful: 0, notHelpful: 1 },
      { name: "Dr. Owner", questions: 1, answered: 1, helpful: 1, notHelpful: 0 },
    ]);
    expect(r.notHelpful).toEqual([
      expect.objectContaining({ by: "Dr. Asker", kindLabel: "Evidence panel", question: "Can doxycycline be given with isotretinoin?", comment: "Missed the pregnancy test.", sources: ["Isotretinoin protocol", "Doxycycline sheet"] }),
    ]);
    expect(r.unanswered.map((q: { question: string }) => q.question)).toEqual(["What dose of tranexamic acid for melasma?"]);
    expect(r.sources).toEqual([
      { title: "Isotretinoin protocol", cited: 2 },
      { title: "Doxycycline sheet", cited: 1 },
    ]);
    expect(r.overrides).toEqual({ total: 3, stops: 1, warnings: 2, byRule: [expect.objectContaining({ count: 2 }), expect.objectContaining({ count: 1 })] });
    expect(r.months).toHaveLength(12);
    // Another clinic's review is its own.
    expect((await json(await reviewRoute(request("/api/ai-review?month=2026-09", { cookie: otherOwner })))).json.questions.total).toBe(0);
  });

  it("tells the clinician owners on the first of the month, from 09:00, once; not the AI lead", async () => {
    expect(jobs.map((j) => [j.name, j.everyMinutes])).toEqual([["ai-review-monthly", 60]]);
    const first = (hour: number) => zonedTimeToUtc({ year: 2026, month: 10, day: 1, hour, minute: 0 }, TZ);
    expect(await sendMonthlyReview(a, first(8))).toBe("not_due");
    expect(await sendMonthlyReview(a, first(10))).toBe("sent");
    expect(await sendMonthlyReview(a, first(11))).toBe("already_sent");
    const sent = await db.notification.findMany({ where: { tenantId: a, kind: "AI_REVIEW" }, select: { userId: true, title: true, href: true, body: true } });
    expect(sent.map((n) => n.userId)).toEqual([ownerId]);
    expect(sent.map((n) => n.userId)).not.toContain(aiLeadId);
    expect(sent[0]).toMatchObject({ title: "AI review for September 2026", href: "/dashboard/evidence/review?month=2026-09" });
    expect(sent[0]!.body).toMatch(/^September 2026: 5 questions \(3 answered from sources or records, 1 not\); 1 rated helpful, 1 not; 3 safety overrides; 1 taken to OpenEvidence\.$/);
  });
});

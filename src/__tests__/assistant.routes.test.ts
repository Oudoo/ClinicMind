/**
 * POST /api/assistant over the real route handler and the test database:
 * permissions (ai:assistant; reception, nurses and assistants get 403),
 * validation, tenant isolation of the patient context, the cohort / patient /
 * clarify / retrieval answers, the AiRun record of every question and the
 * "assistant.query" audit row (criteria, never the answer), and a provider
 * outage answered 502 and still logged.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reindexTenant } from "@/modules/knowledge/ingest";
import { POST as assistant } from "@/app/api/assistant/route";
import { buildEvalClinic, type FixtureClinic } from "@/modules/assistant/eval/fixture";
import { createUser, dbTestsEnabled, deleteTenants, request, sessionCookieFor } from "@/test/db";

const providerSwitch = vi.hoisted(() => ({ fail: false }));

vi.mock("@/lib/ai/provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/provider")>();
  return {
    ...actual,
    chatProvider: (...args: Parameters<typeof actual.chatProvider>) => {
      const real = actual.chatProvider(...args);
      if (!providerSwitch.fail) return real;
      return {
        ...real,
        name: "gemini",
        chat: async () => {
          throw new actual.AiProviderError("gemini", 503, "upstream unavailable");
        },
      };
    },
  };
});

describe.skipIf(!dbTestsEnabled)("POST /api/assistant", () => {
  let f: FixtureClinic;
  let doctorCookie: string;
  let ownerCookie: string;
  let doctorId: string;
  const forbidden: Record<string, string> = {};

  beforeAll(async () => {
    f = await buildEvalClinic((o) => createUser(o));
    await reindexTenant(f.tenantId);
    doctorId = f.doctors.omar;
    doctorCookie = await sessionCookieFor(f.doctors.omar);
    ownerCookie = await sessionCookieFor(f.ownerId);
    for (const role of ["RECEPTIONIST", "NURSE", "ASSISTANT"] as const) {
      const u = await createUser({ tenantId: f.tenantId, role, fullName: `${role} user` });
      forbidden[role] = await sessionCookieFor(u.id);
    }
  }, 120_000);

  afterAll(async () => {
    await deleteTenants([f.tenantId, f.otherTenantId]);
  });

  const post = (body: unknown, cookie = doctorCookie, headers: Record<string, string> = {}) =>
    assistant(request("/api/assistant", { method: "POST", cookie, body, headers }));

  async function lastRun() {
    return db.aiRun.findFirst({ where: { tenantId: f.tenantId }, orderBy: { createdAt: "desc" } });
  }
  async function lastAudit() {
    return db.auditLog.findFirst({ where: { tenantId: f.tenantId, action: "assistant.query" }, orderBy: { createdAt: "desc" } });
  }

  it("requires a session", async () => {
    expect((await post({ query: "Which patients are allergic to penicillin?" }, "")).status).toBe(401);
  });

  it("is forbidden to reception, nurses and assistants (no ai:assistant permission)", async () => {
    for (const [role, cookie] of Object.entries(forbidden)) {
      const res = await post({ query: "Which patients are allergic to penicillin?" }, cookie);
      expect(res.status, role).toBe(403);
    }
    // nothing was logged for a refused question
    expect(await db.auditLog.count({ where: { tenantId: f.tenantId, action: "assistant.query", actorId: { not: null }, NOT: { actorId: { in: [doctorId, f.ownerId] } } } })).toBe(0);
  });

  it("rejects malformed bodies with 422", async () => {
    expect((await post({ query: "" })).status).toBe(422);
    expect((await post({ query: "x".repeat(2001) })).status).toBe(422);
    expect((await post({ query: "Which patients have PCOS?", page: 0 })).status).toBe(422);
    expect((await post({ query: "Which patients have PCOS?", page: "two" })).status).toBe(422);
  });

  it("answers 404 for another clinic's patient as the context", async () => {
    const res = await post({ query: "Any allergies?", patientId: f.otherIds[0] });
    expect(res.status).toBe(404);
  });

  it("refuses a cross-origin browser request", async () => {
    const res = await post({ query: "Which patients have PCOS?" }, doctorCookie, { origin: "https://evil.example", host: "localhost:3000" });
    expect(res.status).toBe(403);
  });

  it("lists every patient for the audit's question, logs an assistant_cohort run and an audit row with the criteria", async () => {
    const res = await post({ query: "Which patients have a documented allergy to lidocaine or penicillin?" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("cohort");
    expect(body.grounded).toBe(true);
    expect(body.cohort.banner).toBe("Answered from the record: 12 patients matched (all shown)");
    expect(body.cohort.total).toBe(12);
    expect(body.cohort.rows).toHaveLength(12);
    expect(body.citations).toHaveLength(12);
    // The answer lists exactly the cited patients, each linked to their record.
    expect(body.citations.map((c: { patientId: string }) => c.patientId).sort()).toEqual(body.cohort.rows.map((r: { patientId: string }) => r.patientId).sort());
    for (const c of body.citations) expect(c.href).toBe(`/dashboard/patients/${c.patientId}`);
    expect(body.criteria).toEqual(["allergy to lidocaine or penicillin"]);
    expect(body.aiRunId).toEqual(expect.any(String));

    const run = await lastRun();
    expect(run).toMatchObject({ id: body.aiRunId, kind: "assistant_cohort", status: "SUCCEEDED", provider: "clinicmind", authorId: doctorId });
    expect(run!.rawPrompt).toBe("Which patients have a documented allergy to lidocaine or penicillin?");
    expect(run!.retrievedContext).toMatchObject({ mode: "cohort", total: 12 });

    const entry = await lastAudit();
    expect(entry).toMatchObject({ actorId: doctorId, entity: "AiRun", entityId: body.aiRunId });
    expect(entry!.after).toMatchObject({
      mode: "cohort",
      kind: "assistant_cohort",
      matched: 12,
      criteria: [{ kind: "allergy", negate: false, match: "any", terms: ["lidocaine", "penicillin"] }],
    });
    // The criteria, never the answer: no patient names in the audit trail.
    const serialized = JSON.stringify(entry!.after);
    for (const row of body.cohort.rows) expect(serialized).not.toContain(row.name);
  });

  it("answers a named-patient question from that patient only and audits the patient id", async () => {
    const res = await post({ query: "Is Tarek Ezzat on Cephalexin?" });
    const body = await res.json();
    expect(body.mode).toBe("patient");
    expect(body.citations.map((c: { patientId: string }) => c.patientId)).toEqual([f.ids.tarek]);
    expect(body.cohort.headline).toMatch(/^No — Tarek Ezzat has no active cephalexin on record\./);
    const entry = await lastAudit();
    expect(entry!.after).toMatchObject({ mode: "patient", patientId: f.ids.tarek });
  });

  it("asks which patient when several match, logging the question", async () => {
    const res = await post({ query: "Is Ahmed on finasteride?" }, ownerCookie);
    const body = await res.json();
    expect(body.mode).toBe("clarify");
    expect(body.clarify.options).toHaveLength(2);
    expect((await lastRun())!.kind).toBe("assistant_cohort");
    expect((await lastAudit())!.after).toMatchObject({ mode: "clarify" });
  });

  it("keeps open questions on retrieval (assistant_chat run, compact retrieved context)", async () => {
    const res = await post({ query: "Compare melasma progress for patients on tranexamic acid" });
    const body = await res.json();
    expect(body.mode).toBe("rag");
    expect(body.citations.length).toBeGreaterThan(0);
    const allowed = [f.ids.tarek, f.ids.camilia];
    for (const c of body.citations) expect(allowed).toContain(c.patientId);
    expect(body.scope).toMatchObject({ patients: 2 });
    expect(body.notices[0]).toMatch(/Searched only the records of the 2 patients/);
    const run = await lastRun();
    expect(run!.kind).toBe("assistant_chat");
    const context = run!.retrievedContext as { id: string; source: string; refId: string; score: number }[];
    expect(Object.keys(context[0]!).sort()).toEqual(["id", "refId", "score", "source"]);
    expect((await lastAudit())!.after).toMatchObject({ mode: "rag", kind: "assistant_chat" });
  });

  it("clamps a page past the end to the last page", async () => {
    const body = await (await post({ query: "Which male patients have PCOS?", page: 3 })).json();
    expect(body.cohort).toMatchObject({ page: 1, total: 1, pages: 1 });
    expect(body.cohort.headline).toBe("1 male patient has PCOS recorded as a condition or diagnosis (shown below).");
  });

  it("answers 502 when the AI provider fails, and still records the question", async () => {
    providerSwitch.fail = true;
    try {
      const res = await post({ query: "Summarise Tarek Ezzat's melasma history" });
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "ai_provider_error", provider: "gemini" });
    } finally {
      providerSwitch.fail = false;
    }
    const run = await lastRun();
    expect(run).toMatchObject({ kind: "assistant_chat", status: "FAILED", provider: "gemini" });
    expect((await lastAudit())!.after).toMatchObject({ status: "failed", patientId: null });
  });
});

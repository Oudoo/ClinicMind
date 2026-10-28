/**
 * POST /api/consultations/transcribe with the offline provider named
 * explicitly: the success path, the AI run and the audit row, and tenant
 * scoping of the optional patient id.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.AI_TRANSCRIPTION_PROVIDER = "echo";
});

// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { POST as transcribe } from "@/app/api/consultations/transcribe/route";
import { createTenant, createUser, deleteTenants, sessionCookieFor } from "@/test/db";
import { audioRequest } from "@/test/audio";

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.skipIf(!hasDb)("POST /api/consultations/transcribe (echo provider)", () => {
  const created: string[] = [];
  let tenantId: string;
  let doctorCookie: string;
  let foreignPatientId: string;

  beforeAll(async () => {
    const stamp = Date.now().toString(36);
    const tenant = await createTenant({ slug: `stt-echo-${stamp}` });
    const other = await createTenant({ slug: `stt-other-${stamp}` });
    created.push(tenant.id, other.id);
    tenantId = tenant.id;
    doctorCookie = await sessionCookieFor((await createUser({ tenantId: tenant.id, role: "DOCTOR" })).id);
    const foreign = await db.patient.create({ data: { tenantId: other.id, fullName: "Elsewhere Patient", gender: "FEMALE", language: "ar" } });
    foreignPatientId = foreign.id;
  });
  afterAll(async () => deleteTenants(created));

  it("returns the transcript, logs an AI run and an audit row", async () => {
    const res = await transcribe(audioRequest(doctorCookie, { mode: "ambient", consent: "true", language: "auto" }, { bytes: 4096, type: "audio/webm" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("echo");
    expect(body.empty).toBe(false);
    expect(body.transcript).toMatch(/^Doctor: \[offline transcription\]/);

    const run = await db.aiRun.findFirst({ where: { tenantId, kind: "transcription" }, orderBy: { createdAt: "desc" } });
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.rawPrompt).toContain("audio/webm");
    expect(run?.rawPrompt).not.toContain("transcription]");

    const auditRow = await db.auditLog.findFirst({ where: { tenantId, action: "consultation.transcribe" }, orderBy: { createdAt: "desc" } });
    expect(auditRow).not.toBeNull();
  });

  it("refuses a patient id from another tenant", async () => {
    const res = await transcribe(audioRequest(doctorCookie, { patientId: foreignPatientId }, { bytes: 512, type: "audio/mp4" }));
    expect(res.status).toBe(404);
  });
});

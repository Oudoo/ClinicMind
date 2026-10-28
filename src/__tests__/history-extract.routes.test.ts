/**
 * POST /api/patients/[id]/history/extract: a dictated background note becomes
 * suggested history lists. With the offline provider the suggestions are
 * empty and say so; nothing is ever written to the patient.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { systemDb as db } from "@/lib/db";
import { POST as extractHistory } from "@/app/api/patients/[id]/history/extract/route";
import { createTenant, createUser, deleteTenants, request, sessionCookieFor } from "@/test/db";

const hasDb = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasDb)("POST /api/patients/[id]/history/extract", () => {
  const created: string[] = [];
  let tenantId: string;
  let nurseCookie: string;
  let patientId: string;
  let foreignPatientId: string;

  beforeAll(async () => {
    const stamp = Date.now().toString(36);
    const tenant = await createTenant({ slug: `hx-${stamp}` });
    const other = await createTenant({ slug: `hx-other-${stamp}` });
    created.push(tenant.id, other.id);
    tenantId = tenant.id;
    nurseCookie = await sessionCookieFor((await createUser({ tenantId: tenant.id, role: "NURSE" })).id);
    patientId = (await db.patient.create({ data: { tenantId: tenant.id, fullName: "History Patient" } })).id;
    foreignPatientId = (await db.patient.create({ data: { tenantId: other.id, fullName: "Foreign Patient" } })).id;
  });
  afterAll(async () => deleteTenants(created));

  const note = "Known hypertensive since 2019, allergic to penicillin, appendectomy in 2010.";

  it("needs a session, a tenant patient and a note of some length", async () => {
    expect((await extractHistory(request(`/api/patients/${patientId}/history/extract`, { body: { text: note } }), idParams(patientId))).status).toBe(401);
    expect((await extractHistory(request(`/api/patients/${foreignPatientId}/history/extract`, { cookie: nurseCookie, body: { text: note } }), idParams(foreignPatientId))).status).toBe(404);
    expect((await extractHistory(request(`/api/patients/${patientId}/history/extract`, { cookie: nurseCookie, body: { text: "short" } }), idParams(patientId))).status).toBe(422);
  });

  it("returns suggestions without saving anything, and logs the run", async () => {
    const res = await extractHistory(request(`/api/patients/${patientId}/history/extract`, { cookie: nurseCookie, body: { text: note } }), idParams(patientId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe("echo");
    expect(body.empty).toBe(true);
    expect(body.suggestions).toEqual({ chronicConditions: [], allergies: [], diagnoses: [], surgeries: [] });

    expect(await db.medicalHistory.findFirst({ where: { patientId } })).toBeNull();
    const run = await db.aiRun.findFirst({ where: { tenantId, kind: "history_extraction" } });
    expect(run?.status).toBe("SUCCEEDED");
    expect(run?.error).toBe("no_structured_data");
  });
});

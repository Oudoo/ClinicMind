import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/db", async () => {
  const { fake } = await import("@/__tests__/helpers/fake-db");
  return { db: fake.db, notDeleted: { deletedAt: null } };
});
vi.mock("@/lib/auth/session", () => ({ getActingContext: vi.fn() }));
vi.mock("@/lib/auth/auth-tokens", () => ({
  // Invitations write AuthToken rows and send mail; neither is part of what these
  // tests assert, and the in-memory fake has no AuthToken model.
  inviteUser: vi.fn(async () => ({
    url: "http://localhost:3000/invite/test-token",
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  })),
}));
vi.mock("@/lib/ai/extraction", async (importOriginal) => ({
  // Keep the schema and normalisers (the sign service uses them); stub only the model call.
  ...(await importOriginal<typeof import("@/lib/ai/extraction")>()),
  extractClinicalData: vi.fn(async () => ({
    data: { symptoms: [], diagnoses: ["Tension headache"], medications: [{ name: "Paracetamol" }], tests: [], followUps: [] },
    raw: "{}",
    provider: "echo",
    model: "echo-1",
    latencyMs: 1,
    empty: false,
  })),
}));
vi.mock("@/lib/ai/provider", () => ({
  chatProvider: () => ({ chat: async () => ({ content: "Summary.", provider: "echo", model: "echo-1", latencyMs: 1 }) }),
}));

import { fake } from "@/__tests__/helpers/fake-db";
import { actorA, jsonRequest, seedTwoTenants, TENANT_A, TENANT_B } from "@/__tests__/helpers/fixtures";
import { getActingContext } from "@/lib/auth/session";
import { extractClinicalData } from "@/lib/ai/extraction";
import { hashEmbedSecret } from "@/lib/embed";
import { POST as extract } from "@/app/api/consultations/extract/route";
import { POST as sign } from "@/app/api/consultations/[id]/sign/route";
import { POST as createAppointmentRoute } from "@/app/api/appointments/route";
import { GET as listTenants, POST as provisionTenant } from "@/app/api/tenants/route";

const mockedContext = vi.mocked(getActingContext);
const mockedExtract = vi.mocked(extractClinicalData);

const slot = { startsAt: "2026-11-02T09:00:00.000Z", endsAt: "2026-11-02T09:30:00.000Z" };
// Extraction requires at least 20 characters of transcript.
const TRANSCRIPT = "Patient reports a mild headache since yesterday.";

beforeEach(() => {
  seedTwoTenants(fake);
  mockedContext.mockReset();
  mockedExtract.mockClear();
  mockedContext.mockResolvedValue(actorA("DOCTOR"));
});

describe("SEC-4 · consultations/extract", () => {
  it("refuses a patient of another tenant with 404 and writes nothing", async () => {
    const res = await extract(jsonRequest("/api/consultations/extract", { patientId: "patient-b", transcript: TRANSCRIPT }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "patient" });
    expect(fake.rows("consultation")).toHaveLength(3); // fixtures only, nothing new
    expect(fake.rows("consultation").filter((c) => c.transcript === TRANSCRIPT)).toHaveLength(0);
    expect(mockedExtract).not.toHaveBeenCalled(); // no model spend on a foreign id
  });

  it("refuses an archived patient of the same tenant", async () => {
    const res = await extract(jsonRequest("/api/consultations/extract", { patientId: "patient-a-deleted", transcript: TRANSCRIPT }));
    expect(res.status).toBe(404);
  });

  it("creates a consultation for the tenant's own patient", async () => {
    const res = await extract(jsonRequest("/api/consultations/extract", { patientId: "patient-a", transcript: TRANSCRIPT }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const created = fake.rows("consultation").find((c) => c.id === body.consultationId);
    expect(created).toMatchObject({ tenantId: TENANT_A.id, patientId: "patient-a", status: "PENDING_REVIEW" });
    expect(mockedExtract).toHaveBeenCalledTimes(1);
  });
});

describe("SEC-4 · consultations/[id]/sign", () => {
  it("cannot sign another tenant's consultation", async () => {
    const res = await sign(jsonRequest("/api/consultations/consult-b/sign", {}), { params: Promise.resolve({ id: "consult-b" }) });
    expect(res.status).toBe(404);
    expect(fake.rows("visit")).toHaveLength(0);
    expect(fake.rows("consultation").find((c) => c.id === "consult-b")?.status).toBe("PENDING_REVIEW");
  });

  it("refuses to append clinical data to a foreign patient even from an own-tenant consultation", async () => {
    const res = await sign(jsonRequest("/api/consultations/consult-a-cross/sign", {}), { params: Promise.resolve({ id: "consult-a-cross" }) });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "patient" });
    expect(fake.rows("visit")).toHaveLength(0);
    expect(fake.rows("medication")).toHaveLength(0);
    expect(fake.rows("medicalHistory")).toHaveLength(0);
    expect(fake.rows("timelineEvent")).toHaveLength(0);
    expect(fake.rows("consultation").find((c) => c.id === "consult-a-cross")?.status).toBe("PENDING_REVIEW");
  });

  it("signs an own consultation and stamps tenantId on every clinical row it writes", async () => {
    const res = await sign(
      jsonRequest("/api/consultations/consult-a/sign", {
        summary: "Tension-type headache.",
        extraction: { diagnoses: ["Tension headache"], medications: [{ name: "Paracetamol", dosage: "500mg" }] },
      }),
      { params: Promise.resolve({ id: "consult-a" }) },
    );
    expect(res.status).toBe(200);
    const { visitId } = await res.json();

    expect(fake.rows("visit").find((v) => v.id === visitId)).toMatchObject({ tenantId: TENANT_A.id, patientId: "patient-a" });
    expect(fake.rows("medication")).toEqual([
      expect.objectContaining({ tenantId: TENANT_A.id, patientId: "patient-a", name: "Paracetamol" }),
    ]);
    expect(fake.rows("medicalHistory")).toEqual([
      expect.objectContaining({ tenantId: TENANT_A.id, patientId: "patient-a", diagnoses: ["Tension headache"] }),
    ]);
    // The visit, the new diagnosis and the new prescription — each stamped with the tenant.
    const timeline = fake.rows("timelineEvent");
    expect(timeline.map((e) => e.kind).sort()).toEqual(["DIAGNOSIS", "PRESCRIPTION", "VISIT"]);
    for (const event of timeline) expect(event).toMatchObject({ tenantId: TENANT_A.id, patientId: "patient-a" });
    expect(fake.rows("consultation").find((c) => c.id === "consult-a")).toMatchObject({ status: "SIGNED", visitId });
  });

  it("requires the consultations:sign permission", async () => {
    mockedContext.mockResolvedValue(actorA("RECEPTIONIST", "reception-a"));
    const res = await sign(jsonRequest("/api/consultations/consult-a/sign", {}), { params: Promise.resolve({ id: "consult-a" }) });
    expect(res.status).toBe(403);
  });
});

describe("SEC-4 · appointments", () => {
  it("refuses another tenant's patient", async () => {
    const res = await createAppointmentRoute(jsonRequest("/api/appointments", { patientId: "patient-b", ...slot }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "patient" });
    expect(fake.rows("appointment")).toHaveLength(0);
    expect(fake.rows("timelineEvent")).toHaveLength(0);
  });

  it("refuses another tenant's doctor", async () => {
    const res = await createAppointmentRoute(
      jsonRequest("/api/appointments", { patientId: "patient-a", doctorId: "doctor-b", ...slot }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "user" });
    expect(fake.rows("appointment")).toHaveLength(0);
  });

  it("refuses a disabled doctor of the same tenant", async () => {
    const res = await createAppointmentRoute(
      jsonRequest("/api/appointments", { patientId: "patient-a", doctorId: "disabled-a", ...slot }),
    );
    expect(res.status).toBe(404);
    expect(fake.rows("appointment")).toHaveLength(0);
  });

  it("refuses another tenant's clinic", async () => {
    const res = await createAppointmentRoute(
      jsonRequest("/api/appointments", { patientId: "patient-a", clinicId: "clinic-b", ...slot }),
    );
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "not_found", entity: "clinic" });
    expect(fake.rows("appointment")).toHaveLength(0);
  });

  it("books when patient, doctor and clinic all belong to the tenant", async () => {
    const res = await createAppointmentRoute(
      jsonRequest("/api/appointments", {
        patientId: "patient-a",
        doctorId: "doctor-a",
        clinicId: "clinic-a",
        reason: "Follow-up",
        ...slot,
      }),
    );
    expect(res.status).toBe(201);
    const { appointment } = await res.json();
    expect(appointment).toMatchObject({
      tenantId: TENANT_A.id,
      patientId: "patient-a",
      doctorId: "doctor-a",
      clinicId: "clinic-a",
      status: "SCHEDULED",
    });
    expect(fake.rows("timelineEvent")).toEqual([
      expect.objectContaining({ tenantId: TENANT_A.id, patientId: "patient-a", kind: "APPOINTMENT" }),
    ]);
  });
});

describe("SEC-3 · /api/tenants requires platform:manage", () => {
  const provisionBody = { slug: "gamma", name: "Gamma Clinic", ownerEmail: "owner@gamma.clinic" };

  it("a clinic owner can neither list nor provision tenants", async () => {
    mockedContext.mockResolvedValue(actorA("CLINIC_OWNER", "owner-a"));
    const list = await listTenants(new Request("http://localhost/api/tenants"));
    expect(list.status).toBe(403);
    await expect(list.json()).resolves.toMatchObject({ error: "forbidden" });

    const create = await provisionTenant(jsonRequest("/api/tenants", provisionBody));
    expect(create.status).toBe(403);
    expect(fake.rows("tenant").map((t) => t.slug)).toEqual([TENANT_A.slug, TENANT_B.slug]);
  });

  it("staff roles are refused too", async () => {
    for (const role of ["DOCTOR", "NURSE", "RECEPTIONIST", "ASSISTANT"] as const) {
      mockedContext.mockResolvedValue(actorA(role));
      expect((await listTenants(new Request("http://localhost/api/tenants"))).status, role).toBe(403);
    }
  });

  it("a super admin lists every tenant and provisions one with a hashed, once-shown embed secret", async () => {
    mockedContext.mockResolvedValue(actorA("SUPER_ADMIN", "super"));
    const list = await listTenants(new Request("http://localhost/api/tenants"));
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      tenants: expect.arrayContaining([
        expect.objectContaining({ slug: TENANT_A.slug }),
        expect.objectContaining({ slug: TENANT_B.slug }),
      ]),
    });

    const create = await provisionTenant(jsonRequest("/api/tenants", provisionBody));
    expect(create.status).toBe(201);
    expect(create.headers.get("cache-control")).toBe("no-store");
    const body = await create.json();
    expect(body.tenant.slug).toBe("gamma");
    expect(body.embedSecret).toMatch(/^cmembed_/);

    const config = fake.rows("tenantEmbedConfig").find((c) => c.tenantId === body.tenant.id);
    expect(config).toMatchObject({ enabled: true, secretHash: hashEmbedSecret(body.embedSecret) });
    expect(config?.secretPrefix).toBe(body.embedSecret.slice(0, 14));
    expect(JSON.stringify(config)).not.toContain(body.embedSecret);
    expect(fake.rows("user").find((u) => u.tenantId === body.tenant.id)).toMatchObject({
      email: "owner@gamma.clinic",
      role: "CLINIC_OWNER",
    });
    expect(fake.rows("tenant").map((t) => t.slug)).not.toContain(TENANT_B.id);
  });
});

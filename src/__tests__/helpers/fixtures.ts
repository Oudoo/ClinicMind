import type { ActingContext } from "@/lib/auth/session";
import type { UserRole } from "@prisma/client";
import { hashEmbedSecret, embedSecretPrefix } from "@/lib/embed";
import type { FakeDb } from "./fake-db";

/** Plaintext embed secrets for the two fixture tenants (hashes are stored). */
export const SECRET_A = "cmembed_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const SECRET_B = "cmembed_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

export const TENANT_A = { id: "tenant-a", slug: "acme", name: "Acme Clinic" };
export const TENANT_B = { id: "tenant-b", slug: "beta", name: "Beta Clinic" };

/**
 * Two fully populated tenants. Every id is deliberately readable so a failing
 * assertion says which side of the boundary leaked.
 */
export function seedTwoTenants(fake: FakeDb) {
  fake.reset();

  fake.seed("tenant", [
    { ...TENANT_A, status: "ACTIVE", branding: null },
    { ...TENANT_B, status: "ACTIVE", branding: null },
  ]);

  fake.seed("tenantEmbedConfig", [
    {
      id: "embed-a",
      tenantId: TENANT_A.id,
      enabled: true,
      allowedOrigins: ["https://care.acme.com", "http://localhost:3000/"],
      secretHash: hashEmbedSecret(SECRET_A),
      secretPrefix: embedSecretPrefix(SECRET_A),
      secretRotatedAt: new Date("2026-10-01T00:00:00Z"),
    },
    {
      id: "embed-b",
      tenantId: TENANT_B.id,
      enabled: true,
      allowedOrigins: ["https://beta.example"],
      secretHash: hashEmbedSecret(SECRET_B),
      secretPrefix: embedSecretPrefix(SECRET_B),
      secretRotatedAt: new Date("2026-10-01T00:00:00Z"),
    },
  ]);

  fake.seed("clinic", [
    { id: "clinic-a", tenantId: TENANT_A.id, name: "Acme Main" },
    { id: "clinic-b", tenantId: TENANT_B.id, name: "Beta Main" },
  ]);

  fake.seed("user", [
    { id: "owner-a", tenantId: TENANT_A.id, email: "owner@acme", role: "CLINIC_OWNER", status: "ACTIVE" },
    { id: "doctor-a", tenantId: TENANT_A.id, email: "doctor@acme", role: "DOCTOR", status: "ACTIVE" },
    { id: "reception-a", tenantId: TENANT_A.id, email: "desk@acme", role: "RECEPTIONIST", status: "ACTIVE" },
    { id: "invited-a", tenantId: TENANT_A.id, email: "new@acme", role: "DOCTOR", status: "INVITED" },
    { id: "disabled-a", tenantId: TENANT_A.id, email: "gone@acme", role: "DOCTOR", status: "DISABLED" },
    { id: "deleted-a", tenantId: TENANT_A.id, email: "del@acme", role: "DOCTOR", status: "ACTIVE", deletedAt: new Date() },
    { id: "doctor-b", tenantId: TENANT_B.id, email: "doctor@beta", role: "DOCTOR", status: "ACTIVE" },
    { id: "super", tenantId: TENANT_A.id, email: "root@platform", role: "SUPER_ADMIN", status: "ACTIVE" },
  ]);

  fake.seed("patient", [
    { id: "patient-a", tenantId: TENANT_A.id, fullName: "Alice A" },
    { id: "patient-a-deleted", tenantId: TENANT_A.id, fullName: "Archived A", deletedAt: new Date() },
    { id: "patient-b", tenantId: TENANT_B.id, fullName: "Bob B" },
  ]);

  fake.seed("consultation", [
    {
      id: "consult-a",
      tenantId: TENANT_A.id,
      patientId: "patient-a",
      doctorId: "doctor-a",
      status: "PENDING_REVIEW",
      transcript: "Patient reports headache.",
      extraction: { diagnoses: ["Tension headache"], medications: [{ name: "Paracetamol" }] },
      summary: "Headache, likely tension-type.",
    },
    {
      id: "consult-b",
      tenantId: TENANT_B.id,
      patientId: "patient-b",
      doctorId: "doctor-b",
      status: "PENDING_REVIEW",
      transcript: "Beta transcript.",
      extraction: { diagnoses: ["Flu"] },
      summary: "Flu.",
    },
    {
      // A row poisoned before the fix: owned by tenant A but pointing at B's patient.
      id: "consult-a-cross",
      tenantId: TENANT_A.id,
      patientId: "patient-b",
      doctorId: "doctor-a",
      status: "PENDING_REVIEW",
      transcript: "Cross-tenant transcript.",
      extraction: { diagnoses: ["Should never land on patient-b"], medications: [{ name: "Nope" }] },
      summary: "cross",
    },
  ]);
}

/** An acting context inside tenant A. */
export function actorA(role: UserRole = "DOCTOR", userId = "doctor-a"): ActingContext {
  return {
    tenantId: TENANT_A.id,
    tenantSlug: TENANT_A.slug,
    tenantName: TENANT_A.name,
    branding: null,
    userId,
    email: `${userId}@acme`,
    role,
  };
}

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

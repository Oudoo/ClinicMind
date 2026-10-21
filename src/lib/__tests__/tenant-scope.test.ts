import { describe, it, expect, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { createFakeDb } from "@/__tests__/helpers/fake-db";
import { seedTwoTenants, TENANT_A, TENANT_B } from "@/__tests__/helpers/fixtures";
import {
  TenantScopeError,
  requireTenantClinic,
  requireTenantPatient,
  requireTenantUser,
} from "@/lib/tenant-scope";

const fake = createFakeDb();
const client = fake.db as Prisma.TransactionClient;

describe("tenant-scope helpers (SEC-4)", () => {
  beforeEach(() => seedTwoTenants(fake));

  describe("requireTenantPatient", () => {
    it("returns the patient when it belongs to the tenant", async () => {
      await expect(requireTenantPatient(TENANT_A.id, "patient-a", client)).resolves.toEqual({
        id: "patient-a",
        tenantId: TENANT_A.id,
      });
    });

    it("throws a 404-mapped TenantScopeError for another tenant's patient", async () => {
      const err = await requireTenantPatient(TENANT_A.id, "patient-b", client).catch((e) => e);
      expect(err).toBeInstanceOf(TenantScopeError);
      expect(err.status).toBe(404);
      expect(err.entity).toBe("patient");
      expect(err.id).toBe("patient-b");
    });

    it("treats archived and unknown patients as not found", async () => {
      await expect(requireTenantPatient(TENANT_A.id, "patient-a-deleted", client)).rejects.toBeInstanceOf(TenantScopeError);
      await expect(requireTenantPatient(TENANT_A.id, "nope", client)).rejects.toBeInstanceOf(TenantScopeError);
    });
  });

  describe("requireTenantUser", () => {
    it("returns the user when they belong to the tenant", async () => {
      const user = await requireTenantUser(TENANT_A.id, "doctor-a", {}, client);
      expect(user).toMatchObject({ id: "doctor-a", tenantId: TENANT_A.id, role: "DOCTOR", status: "ACTIVE" });
    });

    it("rejects users of another tenant", async () => {
      await expect(requireTenantUser(TENANT_A.id, "doctor-b", {}, client)).rejects.toBeInstanceOf(TenantScopeError);
      await expect(requireTenantUser(TENANT_B.id, "doctor-a", {}, client)).rejects.toBeInstanceOf(TenantScopeError);
    });

    it("excludes disabled and archived users by default but allows invited ones", async () => {
      await expect(requireTenantUser(TENANT_A.id, "disabled-a", {}, client)).rejects.toBeInstanceOf(TenantScopeError);
      await expect(requireTenantUser(TENANT_A.id, "deleted-a", {}, client)).rejects.toBeInstanceOf(TenantScopeError);
      await expect(requireTenantUser(TENANT_A.id, "invited-a", {}, client)).resolves.toMatchObject({ id: "invited-a" });
    });

    it("can be narrowed to ACTIVE users only", async () => {
      await expect(
        requireTenantUser(TENANT_A.id, "invited-a", { statuses: ["ACTIVE"] }, client),
      ).rejects.toBeInstanceOf(TenantScopeError);
      await expect(
        requireTenantUser(TENANT_A.id, "doctor-a", { statuses: ["ACTIVE"] }, client),
      ).resolves.toMatchObject({ id: "doctor-a" });
    });
  });

  describe("requireTenantClinic", () => {
    it("accepts the tenant's clinic and rejects another tenant's", async () => {
      await expect(requireTenantClinic(TENANT_A.id, "clinic-a", client)).resolves.toEqual({
        id: "clinic-a",
        tenantId: TENANT_A.id,
      });
      const err = await requireTenantClinic(TENANT_A.id, "clinic-b", client).catch((e) => e);
      expect(err).toBeInstanceOf(TenantScopeError);
      expect(err.entity).toBe("clinic");
    });
  });
});

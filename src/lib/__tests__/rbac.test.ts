import { describe, it, expect } from "vitest";
import {
  can,
  permissionsFor,
  isTenantRole,
  resolveEmbedRole,
  roleWithinCeiling,
  TENANT_ROLES,
} from "@/lib/auth/rbac";
import type { UserRole } from "@prisma/client";

const ALL_ROLES: UserRole[] = ["SUPER_ADMIN", "CLINIC_OWNER", "DOCTOR", "NURSE", "RECEPTIONIST", "ASSISTANT"];

describe("RBAC", () => {
  it("only clinicians may sign clinical decisions", () => {
    expect(can("DOCTOR", "consultations:sign")).toBe(true);
    expect(can("CLINIC_OWNER", "consultations:sign")).toBe(true); // the physician-owner
    expect(can("SUPER_ADMIN", "consultations:sign")).toBe(true);
    expect(can("NURSE", "consultations:sign")).toBe(false);
    expect(can("RECEPTIONIST", "consultations:sign")).toBe(false);
    expect(can("ASSISTANT", "consultations:sign")).toBe(false);
  });

  it("receptionists can manage appointments but not access AI assistant", () => {
    expect(can("RECEPTIONIST", "appointments:write")).toBe(true);
    expect(can("RECEPTIONIST", "ai:assistant")).toBe(false);
  });

  it("super admin has every permission", () => {
    expect(permissionsFor("SUPER_ADMIN")).toContain("platform:manage");
    expect(permissionsFor("SUPER_ADMIN")).toContain("tenant:manage");
    expect(permissionsFor("SUPER_ADMIN")).toContain("audit:read");
  });

  it("assistant role is read-mostly", () => {
    expect(can("ASSISTANT", "patients:read")).toBe(true);
    expect(can("ASSISTANT", "patients:write")).toBe(false);
  });

  describe("platform vs tenant management (SEC-3)", () => {
    it("platform:manage is held by SUPER_ADMIN only", () => {
      for (const role of ALL_ROLES) {
        expect(can(role, "platform:manage"), role).toBe(role === "SUPER_ADMIN");
      }
    });

    it("clinic owners keep tenant:manage for their own tenant", () => {
      expect(can("CLINIC_OWNER", "tenant:manage")).toBe(true);
      expect(can("CLINIC_OWNER", "embed:manage")).toBe(true);
      expect(can("CLINIC_OWNER", "platform:manage")).toBe(false);
    });

    it("no staff role can manage the tenant or the platform", () => {
      for (const role of ["DOCTOR", "NURSE", "RECEPTIONIST", "ASSISTANT"] as const) {
        expect(can(role, "tenant:manage"), role).toBe(false);
        expect(can(role, "platform:manage"), role).toBe(false);
      }
    });
  });

  describe("embed role ceiling (SEC-2)", () => {
    it("tenant roles never include SUPER_ADMIN", () => {
      expect(TENANT_ROLES).not.toContain("SUPER_ADMIN");
      expect(isTenantRole("SUPER_ADMIN")).toBe(false);
      expect(isTenantRole("DOCTOR")).toBe(true);
      expect(isTenantRole("owner")).toBe(false);
      expect(isTenantRole(undefined)).toBe(false);
    });

    it("a role is within the ceiling only when it grants nothing extra", () => {
      expect(roleWithinCeiling("ASSISTANT", "DOCTOR")).toBe(true);
      expect(roleWithinCeiling("RECEPTIONIST", "NURSE")).toBe(true);
      expect(roleWithinCeiling("DOCTOR", "DOCTOR")).toBe(true);
      expect(roleWithinCeiling("DOCTOR", "RECEPTIONIST")).toBe(false);
      // The physician-owner holds every DOCTOR permission, so an owner may be
      // narrowed to DOCTOR; a doctor can never be widened to owner.
      expect(roleWithinCeiling("DOCTOR", "CLINIC_OWNER")).toBe(true);
      expect(roleWithinCeiling("CLINIC_OWNER", "DOCTOR")).toBe(false);
      expect(roleWithinCeiling("SUPER_ADMIN", "CLINIC_OWNER")).toBe(false);
      for (const role of ALL_ROLES) expect(roleWithinCeiling(role, "SUPER_ADMIN"), role).toBe(true);
    });

    it("resolves the mintable role: the user's own by default, narrower on request, never wider", () => {
      expect(resolveEmbedRole("DOCTOR")).toBe("DOCTOR");
      expect(resolveEmbedRole("DOCTOR", null)).toBe("DOCTOR");
      expect(resolveEmbedRole("DOCTOR", "ASSISTANT")).toBe("ASSISTANT");
      expect(resolveEmbedRole("RECEPTIONIST", "DOCTOR")).toBeNull();
      expect(resolveEmbedRole("CLINIC_OWNER", "DOCTOR")).toBe("DOCTOR");
      expect(resolveEmbedRole("DOCTOR", "CLINIC_OWNER")).toBeNull();
      expect(resolveEmbedRole("DOCTOR", "SUPER_ADMIN")).toBeNull();
      expect(resolveEmbedRole("SUPER_ADMIN", "SUPER_ADMIN")).toBeNull();
      expect(resolveEmbedRole("DOCTOR", "not-a-role")).toBeNull();
    });

    it("caps a platform admin at the tenant's top role", () => {
      expect(resolveEmbedRole("SUPER_ADMIN")).toBe("CLINIC_OWNER");
      expect(resolveEmbedRole("SUPER_ADMIN", "DOCTOR")).toBe("DOCTOR");
    });
  });
});

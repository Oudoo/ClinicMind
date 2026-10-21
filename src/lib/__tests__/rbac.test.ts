import { describe, it, expect } from "vitest";
import { can, permissionsFor } from "@/lib/auth/rbac";

describe("RBAC", () => {
  it("only clinicians may sign clinical decisions", () => {
    expect(can("DOCTOR", "consultations:sign")).toBe(true);
    expect(can("SUPER_ADMIN", "consultations:sign")).toBe(true);
    expect(can("RECEPTIONIST", "consultations:sign")).toBe(false);
    expect(can("ASSISTANT", "consultations:sign")).toBe(false);
  });

  it("receptionists can manage appointments but not access AI assistant", () => {
    expect(can("RECEPTIONIST", "appointments:write")).toBe(true);
    expect(can("RECEPTIONIST", "ai:assistant")).toBe(false);
  });

  it("super admin has every permission", () => {
    expect(permissionsFor("SUPER_ADMIN")).toContain("tenant:manage");
    expect(permissionsFor("SUPER_ADMIN")).toContain("audit:read");
  });

  it("assistant role is read-mostly", () => {
    expect(can("ASSISTANT", "patients:read")).toBe(true);
    expect(can("ASSISTANT", "patients:write")).toBe(false);
  });
});

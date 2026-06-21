import type { UserRole } from "@prisma/client";

/**
 * Role-Based Access Control.
 *
 * Permissions are coarse-grained capabilities; each role maps to a set. The
 * `can()` helper is the single choke point used by API routes and server actions.
 */
export type Permission =
  | "tenant:manage"
  | "tenant:billing"
  | "users:manage"
  | "patients:read"
  | "patients:write"
  | "appointments:read"
  | "appointments:write"
  | "consultations:read"
  | "consultations:sign" // only clinicians may sign clinical decisions
  | "ai:assistant"
  | "conversations:read"
  | "reports:read"
  | "analytics:read"
  | "audit:read"
  | "embed:manage";

const ALL: Permission[] = [
  "tenant:manage",
  "tenant:billing",
  "users:manage",
  "patients:read",
  "patients:write",
  "appointments:read",
  "appointments:write",
  "consultations:read",
  "consultations:sign",
  "ai:assistant",
  "conversations:read",
  "reports:read",
  "analytics:read",
  "audit:read",
  "embed:manage",
];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: ALL,
  CLINIC_OWNER: [
    "tenant:manage",
    "tenant:billing",
    "users:manage",
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "consultations:read",
    "ai:assistant",
    "conversations:read",
    "reports:read",
    "analytics:read",
    "audit:read",
    "embed:manage",
  ],
  DOCTOR: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "consultations:read",
    "consultations:sign",
    "ai:assistant",
    "conversations:read",
    "reports:read",
    "analytics:read",
  ],
  NURSE: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "consultations:read",
    "conversations:read",
  ],
  RECEPTIONIST: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "conversations:read",
  ],
  ASSISTANT: ["patients:read", "appointments:read", "conversations:read"],
};

export function permissionsFor(role: UserRole): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function can(role: UserRole, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Throwing variant for use in API handlers / server actions. */
export function assertCan(role: UserRole, permission: Permission): void {
  if (!can(role, permission)) {
    throw new RbacError(`Role ${role} lacks permission ${permission}`);
  }
}

export class RbacError extends Error {
  readonly status = 403;
  constructor(message: string) {
    super(message);
    this.name = "RbacError";
  }
}

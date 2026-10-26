import type { UserRole } from "@prisma/client";

/**
 * Role-Based Access Control.
 *
 * Permissions are coarse-grained capabilities; each role maps to a set. The
 * `can()` helper is the single choke point used by API routes and server actions.
 *
 * Two scopes exist:
 *   - `platform:manage` — platform-wide operations (provisioning and listing
 *     tenants). Held by SUPER_ADMIN only; never by a tenant role.
 *   - `tenant:manage` — settings of the actor's *own* tenant (branding, domain,
 *     embed configuration). Held by CLINIC_OWNER and SUPER_ADMIN.
 */
export type Permission =
  | "platform:manage"
  | "tenant:manage"
  | "tenant:billing"
  | "users:manage"
  | "patients:read"
  | "patients:write"
  | "patients:export" // bulk export of the patient list (personal data leaving the system)
  | "appointments:read"
  | "appointments:write"
  | "consultations:read"
  | "consultations:sign" // only clinicians may sign clinical decisions
  | "ai:assistant"
  | "conversations:read"
  | "reports:read"
  | "analytics:read"
  | "audit:read"
  | "embed:manage"
  | "leads:read"
  | "leads:write"
  | "conversations:write" // reply from the reception inbox
  | "payments:write" // record deposits, payments and refunds
  | "finance:read" // the finance dashboard (revenue by doctor is owner-only)
  | "concierge:read"
  | "concierge:write"; // answer check-ins, acknowledge and resolve escalations

const ALL: Permission[] = [
  "platform:manage",
  "tenant:manage",
  "tenant:billing",
  "users:manage",
  "patients:read",
  "patients:write",
  "patients:export",
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
  "leads:read",
  "leads:write",
  "conversations:write",
  "payments:write",
  "finance:read",
  "concierge:read",
  "concierge:write",
];

const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  SUPER_ADMIN: ALL,
  // The clinic owner is the physician-owner: full administrative rights plus the
  // clinical rights of a doctor (bookable, may sign). Non-clinical administrators
  // get ASSISTANT; a per-user clinician flag is the planned refinement.
  CLINIC_OWNER: [
    "tenant:manage",
    "tenant:billing",
    "users:manage",
    "patients:read",
    "patients:write",
    "patients:export",
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
    "leads:read",
    "leads:write",
    "conversations:write",
    "payments:write",
    "finance:read",
    "concierge:read",
    "concierge:write",
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
    "leads:read",
    "conversations:write",
    "concierge:read",
    "concierge:write",
  ],
  NURSE: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "consultations:read",
    "conversations:read",
    "conversations:write",
    "leads:read",
    "leads:write",
    "payments:write",
    "concierge:read",
    "concierge:write",
  ],
  RECEPTIONIST: [
    "patients:read",
    "patients:write",
    "appointments:read",
    "appointments:write",
    "conversations:read",
    "conversations:write",
    "leads:read",
    "leads:write",
    "payments:write",
    "concierge:read",
  ],
  ASSISTANT: ["patients:read", "appointments:read", "conversations:read", "leads:read"],
};

/**
 * Roles that exist *inside* a tenant. SUPER_ADMIN is a platform role: it is
 * never mintable through the embed bridge and never carried by an embed token.
 * These are also the roles a tenant administrator may assign to staff.
 */
export const TENANT_ROLES = [
  "CLINIC_OWNER",
  "DOCTOR",
  "NURSE",
  "RECEPTIONIST",
  "ASSISTANT",
] as const satisfies readonly UserRole[];

export type TenantRole = (typeof TENANT_ROLES)[number];

/**
 * Roles an actor may grant when inviting staff. Only a super-admin can mint
 * another super-admin; everyone else is limited to the tenant roles.
 */
export function grantableRoles(actorRole: UserRole): readonly UserRole[] {
  return actorRole === "SUPER_ADMIN" ? ["SUPER_ADMIN", ...TENANT_ROLES] : TENANT_ROLES;
}

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

// ── Tenant roles & the embed role ceiling ────────────────────────────────────

export function isTenantRole(role: unknown): role is TenantRole {
  return typeof role === "string" && (TENANT_ROLES as readonly string[]).includes(role);
}

/** True when `requested` grants nothing that `ceiling` does not already grant. */
export function roleWithinCeiling(requested: UserRole, ceiling: UserRole): boolean {
  const allowed = new Set(permissionsFor(ceiling));
  return permissionsFor(requested).every((p) => allowed.has(p));
}

/**
 * Resolve the role an embed token may carry for a user whose stored role is
 * `userRole`. The host backend may ask for a *narrower* role than the user's
 * own (e.g. mint a read-only session for a doctor) but can never widen it, and
 * SUPER_ADMIN is never mintable. Returns null when the request is not allowed.
 */
export function resolveEmbedRole(userRole: UserRole, requested?: string | null): TenantRole | null {
  if (requested == null) {
    // A platform admin acting inside a tenant gets that tenant's top role.
    return isTenantRole(userRole) ? userRole : "CLINIC_OWNER";
  }
  if (!isTenantRole(requested)) return null;
  return roleWithinCeiling(requested, userRole) ? requested : null;
}

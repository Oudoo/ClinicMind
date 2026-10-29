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
  | "prices:manage" // edit the price list (codes, units, prices from a date)
  | "concierge:read"
  | "concierge:write" // answer check-ins, acknowledge and resolve escalations
  | "recalls:read" // the recall worklist and a patient's recalls
  | "recalls:write" // log calls and messages, book, snooze, decline, add a recall
  | "recalls:manage" // the recall rules (intervals, reviews, owners, channels)
  | "evidence:read" // the clinic's evidence library
  | "evidence:write" // add and edit sources (an edited approved source waits for approval again)
  | "evidence:approve" // approve and retire sources: what the evidence panel may quote (clinicians only, see canApproveEvidence)
  | "evidence:ask" // ask the evidence panel (clinicians only, see canAskEvidence)
  | "quotes:read" // treatment plans and quotes, and how many are accepted
  | "quotes:write" // make, give, send and record the answer to a treatment plan
  | "expenses:read" // the clinic's expenses, bills to pay and suppliers (salaries are the owner's alone)
  | "expenses:write" // record an expense or a bill, pay it (cash out of the drawer too), attach its receipt, add a supplier
  | "lab:read" // lab orders, where they stand and which are late (their results: clinicians only, see canReadLabResults)
  | "lab:write" // send a lab order, record its result, cancel it
  | "insurance:read" // payers, patients' covers, approvals, claims and what each payer owes
  | "insurance:write" // add or end a patient's cover, ask for and record an approval, send claims in a batch
  | "insurance:manage"; // payers and their contracts, the payers' answers and money, writing off what they refuse

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
  "prices:manage",
  "concierge:read",
  "concierge:write",
  "recalls:read",
  "recalls:write",
  "recalls:manage",
  "evidence:read",
  "evidence:write",
  "evidence:approve",
  "evidence:ask",
  "quotes:read",
  "quotes:write",
  "expenses:read",
  "expenses:write",
  "lab:read",
  "lab:write",
  "insurance:read",
  "insurance:write",
  "insurance:manage",
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
    "prices:manage",
    "concierge:read",
    "concierge:write",
    "recalls:read",
    "recalls:write",
    "recalls:manage",
    "evidence:read",
    "evidence:write",
    "evidence:approve",
    "evidence:ask",
    "quotes:read",
    "quotes:write",
    "expenses:read",
    "expenses:write",
    "lab:read",
    "lab:write",
    "insurance:read",
    "insurance:write",
    "insurance:manage",
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
    "recalls:read",
    "recalls:write",
    "evidence:read",
    "evidence:write",
    "evidence:ask",
    "quotes:read",
    "quotes:write",
    "lab:read",
    "lab:write",
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
    "recalls:read",
    "recalls:write",
    "quotes:read",
    "quotes:write",
    "expenses:read",
    "expenses:write",
    "lab:read",
    "lab:write",
    "insurance:read",
    "insurance:write",
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
    "recalls:read",
    "recalls:write",
    "quotes:read",
    "quotes:write",
    "expenses:read",
    "expenses:write",
    "lab:read",
    "lab:write",
    "insurance:read",
    "insurance:write",
  ],
  ASSISTANT: ["patients:read", "appointments:read", "conversations:read", "leads:read", "recalls:read"],
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

/**
 * Signing clinical decisions (consultation notes, procedures, protocol
 * approvals) needs the role's consultations:sign permission AND the person's
 * clinician mark. An owner-level administrator who is not a clinician (the
 * Clinic AI lead, a practice manager) and the platform administrator cannot
 * sign, whatever their role.
 */
export function canSignClinical(actor: { role: UserRole; isClinician: boolean }): boolean {
  return actor.isClinician && can(actor.role, "consultations:sign");
}

export function assertCanSignClinical(actor: { role: UserRole; isClinician: boolean }): void {
  if (!canSignClinical(actor)) {
    throw new RbacError(
      actor.isClinician ? `Role ${actor.role} lacks permission consultations:sign` : "Only clinicians may sign clinical records",
    );
  }
}

/**
 * The AI assistant answers clinical questions over patient records: the
 * role's ai:assistant permission AND the clinician mark. The Clinic AI lead
 * and the platform administrator ask no clinical questions, whatever their
 * role; nurses and reception have no ai:assistant at all.
 */
export function canUseAssistant(actor: { role: UserRole; isClinician: boolean }): boolean {
  return actor.isClinician && can(actor.role, "ai:assistant");
}

export function assertCanUseAssistant(actor: { role: UserRole; isClinician: boolean }): void {
  if (!canUseAssistant(actor)) {
    throw new RbacError(actor.isClinician ? `Role ${actor.role} lacks permission ai:assistant` : "Only clinicians may ask clinical questions");
  }
}

/** A lab's result is clinical: the roles that read consultations read it; the desk sees where an order stands. */
export function canReadLabResults(role: UserRole): boolean {
  return can(role, "lab:read") && can(role, "consultations:read");
}

/**
 * Asking the evidence panel a clinical question needs the role's evidence:ask
 * permission AND the person's clinician mark, as signing does: the Clinic AI
 * lead and the platform administrator do not ask clinical questions, whatever
 * their role.
 */
export function canAskEvidence(actor: { role: UserRole; isClinician: boolean }): boolean {
  return actor.isClinician && can(actor.role, "evidence:ask");
}

export function assertCanAskEvidence(actor: { role: UserRole; isClinician: boolean }): void {
  if (!canAskEvidence(actor)) {
    throw new RbacError(actor.isClinician ? `Role ${actor.role} lacks permission evidence:ask` : "Only clinicians may ask clinical questions");
  }
}

/** Deciding what the evidence panel may quote is a clinician's call too: the owner, with the clinician mark. */
export function canApproveEvidence(actor: { role: UserRole; isClinician: boolean }): boolean {
  return actor.isClinician && can(actor.role, "evidence:approve");
}

export function assertCanApproveEvidence(actor: { role: UserRole; isClinician: boolean }): void {
  if (!canApproveEvidence(actor)) {
    throw new RbacError(actor.isClinician ? `Role ${actor.role} lacks permission evidence:approve` : "Only clinicians may approve clinical sources");
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

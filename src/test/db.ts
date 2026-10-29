import { randomBytes } from "node:crypto";
import type { UserRole, UserStatus } from "@prisma/client";
import { beforeAll } from "vitest";
// Tests seed and inspect across clinics: the system connection, outside row-level security.
import { enterSystemScope, systemDb as db } from "@/lib/db";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/session";

/**
 * Helpers for the database-backed route tests. Each test file creates its own
 * tenants (unique slugs) and deletes them afterwards; cascades remove users,
 * sessions, tokens, patients and everything else beneath them.
 */
export const dbTestsEnabled = Boolean(process.env.DATABASE_URL);

/**
 * For a test file that calls services directly rather than through a route:
 * its hooks and tests run in the system database scope (across clinics,
 * outside row-level security). Without it, code a test calls outside a route
 * sees no clinic's rows, exactly like production code outside a request; route
 * handlers enter their request's own scope either way. Call at the top level.
 */
export function runAsSystem(): void {
  beforeAll(() => enterSystemScope());
}

export function uniqueSlug(prefix = "t"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export async function createTenant(opts: { slug?: string; name?: string; status?: "ACTIVE" | "SUSPENDED" } = {}) {
  const slug = opts.slug ?? uniqueSlug();
  return db.tenant.create({
    data: {
      slug,
      name: opts.name ?? `Clinic ${slug}`,
      status: opts.status ?? "ACTIVE",
      embed: { create: { enabled: true } },
      clinics: { create: { name: `Clinic ${slug}` } },
    },
  });
}

export async function createUser(opts: {
  tenantId: string;
  email?: string;
  role?: UserRole;
  status?: UserStatus;
  password?: string | null;
  fullName?: string;
  /** Defaults to true for doctors and owners, as the migration set existing accounts. */
  isClinician?: boolean;
}) {
  const password = opts.password === undefined ? "correct horse battery staple" : opts.password;
  return db.user.create({
    data: {
      tenantId: opts.tenantId,
      email: opts.email ?? `${uniqueSlug("user")}@example.test`,
      fullName: opts.fullName ?? "Test User",
      role: opts.role ?? "CLINIC_OWNER",
      status: opts.status ?? "ACTIVE",
      passwordHash: password ? await hashPassword(password) : null,
      isClinician: opts.isClinician ?? ["DOCTOR", "CLINIC_OWNER"].includes(opts.role ?? "CLINIC_OWNER"),
    },
  });
}

/**
 * Open a cash shift for each user, at the tenant's first branch unless one is
 * given: money taken today goes into the cashier's open shift (see cash.ts).
 */
export async function openShifts(tenantId: string, userIds: string[], clinicId?: string): Promise<void> {
  const branch = clinicId ?? (await db.clinic.findFirstOrThrow({ where: { tenantId, deletedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { id: true } })).id;
  await db.cashShift.createMany({ data: userIds.map((userId) => ({ tenantId, clinicId: branch, userId, openingFloat: 0, openedAt: new Date() })) });
}

/** Sign a user in the way the login route does and return the Cookie header value. */
export async function sessionCookieFor(userId: string): Promise<string> {
  const session = await createSession(userId, { userAgent: "vitest" });
  return `${SESSION_COOKIE}=${session.token}`;
}

/**
 * Remove tenants and everything beneath them. The audit log is append-only at
 * the database level; cascading its rows requires the explicit opt-in flag
 * inside the same transaction (see the RLS/audit migration).
 */
export async function deleteTenants(ids: string[]): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL app.allow_audit_delete = 'on'`),
    db.tenant.deleteMany({ where: { id: { in: ids } } }),
  ]);
}

/** Build a Request against a route handler. */
export function request(
  path: string,
  init: { method?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  return new Request(`http://localhost:3000${path}`, {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body,
  });
}

/** Extract the raw value of a Set-Cookie header on a response, or null. */
export function cookieValue(res: Response, name: string): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]*)`).exec(header);
  return match ? match[1]! : null;
}

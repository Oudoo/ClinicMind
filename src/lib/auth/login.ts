import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { AUTH_RATE_WINDOW_MS, LOGIN_LOCKOUT_FAILURES } from "./constants";
import { verifyDummyPassword, verifyPassword } from "./password";
import { normalizeEmail } from "./request";

/**
 * Password sign-in.
 *
 * E-mail addresses are unique per tenant, not globally, so a sign-in first
 * collects every ACTIVE-tenant user with that address (optionally narrowed to
 * one tenant by slug) and verifies the password against each. In practice that
 * is one user; when the same credentials are valid in several tenants the
 * caller is asked to name the clinic. Every attempt against a known user is
 * recorded as a `LoginEvent` and in the clinic's audit log (`auth.login`,
 * `auth.login_failed`, `auth.login_locked`), and an account with too many
 * recent failures is locked for the rest of the window before any password is
 * checked.
 */
export interface LoginInput {
  email: string;
  password: string;
  tenantSlug?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string | null;
  role: string;
  tenant: { id: string; slug: string; name: string };
}

export type LoginResult =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; reason: "invalid_credentials" }
  | { ok: false; reason: "tenant_required" }
  | { ok: false; reason: "locked"; retryAfterSeconds: number };

export async function authenticateWithPassword(input: LoginInput): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const candidates = await db.user.findMany({
    where: {
      email: { equals: email, mode: "insensitive" },
      deletedAt: null,
      tenant: {
        deletedAt: null,
        status: "ACTIVE",
        ...(input.tenantSlug ? { slug: input.tenantSlug } : {}),
      },
    },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
    take: 10,
  });

  if (candidates.length === 0) {
    await verifyDummyPassword();
    return { ok: false, reason: "invalid_credentials" };
  }

  const meta = { ip: input.ip ?? null, userAgent: input.userAgent ?? null };
  const verified: typeof candidates = [];
  let lockedFor = 0;

  for (const user of candidates) {
    const lock = await lockoutFor(user.id);
    if (lock > 0) {
      lockedFor = Math.max(lockedFor, lock);
      await auditSignIn(user, "auth.login_locked", meta, { retryAfterSeconds: lock });
      continue;
    }
    const ok =
      user.status === "ACTIVE" && (await verifyPassword(user.passwordHash, input.password));
    if (ok) {
      verified.push(user);
    } else {
      await recordLoginEvent(user.id, false, meta);
      await auditSignIn(user, "auth.login_failed", meta, {
        reason: user.status === "ACTIVE" ? "wrong_password" : `account_${user.status.toLowerCase()}`,
      });
    }
  }

  if (verified.length === 1) {
    const user = verified[0]!;
    await recordLoginEvent(user.id, true, meta);
    await auditSignIn(user, "auth.login", meta);
    return {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        tenant: user.tenant,
      },
    };
  }
  if (verified.length > 1) return { ok: false, reason: "tenant_required" };
  if (lockedFor > 0) return { ok: false, reason: "locked", retryAfterSeconds: lockedFor };
  return { ok: false, reason: "invalid_credentials" };
}

/** A sign-in attempt in the account's clinic audit log (who, when, from where; never the password). */
async function auditSignIn(
  user: { id: string; tenantId: string; email: string },
  action: "auth.login" | "auth.login_failed" | "auth.login_locked",
  meta: { ip: string | null; userAgent: string | null },
  after?: Record<string, unknown>,
): Promise<void> {
  await audit({
    tenantId: user.tenantId,
    actorId: user.id,
    actorEmail: user.email,
    action,
    entity: "User",
    entityId: user.id,
    patientId: null,
    ip: meta.ip,
    device: meta.userAgent,
    after,
  });
}

async function recordLoginEvent(
  userId: string,
  success: boolean,
  meta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  await db.loginEvent.create({
    data: { userId, success, ip: meta.ip, userAgent: meta.userAgent },
  });
}

/**
 * Seconds the account stays locked, or 0. Counts failures inside the window
 * that happened after the most recent successful sign-in.
 */
async function lockoutFor(userId: string): Promise<number> {
  const windowStart = new Date(Date.now() - AUTH_RATE_WINDOW_MS);
  const lastSuccess = await db.loginEvent.findFirst({
    where: { userId, success: true, createdAt: { gte: windowStart } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const failures = await db.loginEvent.findMany({
    where: {
      userId,
      success: false,
      createdAt: { gt: lastSuccess ? lastSuccess.createdAt : windowStart },
    },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
    take: LOGIN_LOCKOUT_FAILURES,
  });
  if (failures.length < LOGIN_LOCKOUT_FAILURES) return 0;
  const oldest = failures[0]!.createdAt.getTime();
  return Math.max(1, Math.ceil((oldest + AUTH_RATE_WINDOW_MS - Date.now()) / 1000));
}

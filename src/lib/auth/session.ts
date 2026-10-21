import { cookies, headers } from "next/headers";
import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyEmbedToken, type EmbedClaims } from "@/lib/embed";
import { isTenantRole, roleWithinCeiling } from "@/lib/auth/rbac";
import type { UserRole } from "@prisma/client";

/**
 * Resolves the acting context (tenant + user + role) for a request.
 *
 * Order of resolution:
 *   1. Embed token (cookie `cm_embed` or `Authorization: Bearer`) — the path used
 *      when ClinicMind is framed inside the GROW Engine dashboard or a client site.
 *      The token is never trusted on its own: the user it names must be an
 *      active member of the tenant and the role it carries may not exceed that
 *      user's stored role. A token that verifies but fails those checks is
 *      rejected outright (no fallback to the strategies below).
 *   2. Host tenant header `x-clinicmind-tenant` (set by middleware from the URL).
 *   3. Development fallback to the seeded `demo` tenant so the app is runnable
 *      end-to-end without standing up the host SSO.
 */
export interface ActingContext {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  branding: unknown;
  userId: string | null;
  email: string | null;
  role: UserRole;
}

export async function getActingContext(): Promise<ActingContext | null> {
  const cookieStore = cookies();
  const headerStore = headers();

  const bearer = headerStore.get("authorization")?.replace(/^Bearer\s+/i, "");
  const token = cookieStore.get("cm_embed")?.value ?? bearer;

  if (token) {
    let claims: EmbedClaims | null = null;
    try {
      claims = await verifyEmbedToken(token);
    } catch {
      // Not a valid/current embed token — fall through to the other strategies.
    }
    if (claims) return contextForEmbedClaims(claims);
  }

  const headerSlug = headerStore.get("x-clinicmind-tenant");
  if (headerSlug) {
    const ctx = await contextForSlug(headerSlug);
    if (ctx) return ctx;
  }

  if (env.NODE_ENV !== "production") {
    return contextForSlug("demo");
  }

  return null;
}

/**
 * Bind verified embed claims to a real user record. The token's role is only
 * honoured when it is a tenant role within the ceiling of the user's own role
 * (SEC-2): the host backend can narrow a session, never widen it.
 */
async function contextForEmbedClaims(claims: EmbedClaims): Promise<ActingContext | null> {
  const tenant = await loadTenant({ id: claims.tenantId, status: "ACTIVE" });
  if (!tenant) return null;

  const user = await loadUser(tenant.id, claims.userId);
  if (!user) return null;

  if (!isTenantRole(claims.role) || !roleWithinCeiling(claims.role, user.role)) return null;

  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    branding: tenant.branding,
    userId: user.id,
    email: user.email,
    role: claims.role,
  };
}

async function contextForSlug(slug: string): Promise<ActingContext | null> {
  const tenant = await loadTenant({ slug });
  if (!tenant) return null;
  const owner = await db.user.findFirst({
    where: { tenantId: tenant.id, role: { in: ["CLINIC_OWNER", "DOCTOR", "SUPER_ADMIN"] }, ...notDeleted },
    orderBy: { createdAt: "asc" },
  });
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    tenantName: tenant.name,
    branding: tenant.branding,
    userId: owner?.id ?? null,
    email: owner?.email ?? null,
    role: owner?.role ?? "CLINIC_OWNER",
  };
}

async function loadTenant(where: { id?: string; slug?: string; status?: "ACTIVE" }) {
  try {
    return await db.tenant.findFirst({
      where: { ...where, ...notDeleted },
      select: { id: true, slug: true, name: true, branding: true },
    });
  } catch {
    return null;
  }
}

async function loadUser(tenantId: string, userId: string) {
  try {
    return await db.user.findFirst({
      where: { id: userId, tenantId, status: "ACTIVE", ...notDeleted },
      select: { id: true, email: true, role: true },
    });
  } catch {
    return null;
  }
}

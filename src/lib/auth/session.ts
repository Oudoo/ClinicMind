import { cookies, headers } from "next/headers";
import { db, notDeleted } from "@/lib/db";
import { env } from "@/lib/env";
import { verifyEmbedToken } from "@/lib/embed";
import type { UserRole } from "@prisma/client";

/**
 * Resolves the acting context (tenant + user + role) for a request.
 *
 * Order of resolution:
 *   1. Embed token (cookie `cm_embed` or `Authorization: Bearer`) — the path used
 *      when ClinicMind is framed inside the GROW Engine dashboard or a client site.
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
    try {
      const claims = await verifyEmbedToken(token);
      const tenant = await loadTenant({ id: claims.tenantId });
      if (tenant) {
        return {
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          tenantName: tenant.name,
          branding: tenant.branding,
          userId: claims.userId,
          email: null,
          role: (claims.role as UserRole) ?? "ASSISTANT",
        };
      }
    } catch {
      // fall through to other strategies
    }
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

async function loadTenant(where: { id?: string; slug?: string }) {
  try {
    return await db.tenant.findFirst({
      where: { ...where, ...notDeleted },
      select: { id: true, slug: true, name: true, branding: true },
    });
  } catch {
    return null;
  }
}

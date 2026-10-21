import { z } from "zod";
import { NextResponse } from "next/server";
import { db, notDeleted } from "@/lib/db";
import {
  EMBED_SECRET_HEADER,
  embedSecretMatches,
  isOriginAllowed,
  normalizeOrigin,
  signEmbedToken,
} from "@/lib/embed";
import { TENANT_ROLES, resolveEmbedRole } from "@/lib/auth/rbac";
import { TenantScopeError, requireTenantUser } from "@/lib/tenant-scope";
import { audit } from "@/lib/audit";
import { handleApiError, ok } from "@/lib/api";

export const dynamic = "force-dynamic";

const Body = z.object({
  tenantSlug: z.string().min(1),
  /** Id of an ACTIVE ClinicMind user of that tenant — the session acts as them. */
  userId: z.string().min(1),
  /**
   * Optional narrower role for the session. Must be a tenant role (SUPER_ADMIN
   * is not accepted) and may not grant more than the user's own role.
   */
  role: z.enum(TENANT_ROLES).optional(),
  /** Origin of the page that will frame ClinicMind; must be allow-listed. */
  origin: z.string().url(),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

function deny(error: string, status: 401 | 403) {
  return NextResponse.json({ error }, { status, ...NO_STORE });
}

/**
 * Server-to-server: mint a short-lived embed session token.
 *
 * The client's backend calls this with the tenant's embed *secret* (kept
 * server-side, never in the browser) to bridge their own logged-in session into
 * an authenticated, tenant-scoped ClinicMind iframe. Checks, in order:
 *
 *   1. secret present → tenant active, embedding enabled, secret hash matches
 *      (constant-time);
 *   2. `origin` is on the tenant's allow-list;
 *   3. `userId` is an ACTIVE user of that tenant;
 *   4. the requested role (default: the user's own) is a tenant role within the
 *      user's ceiling — a tenant secret can never mint SUPER_ADMIN.
 */
export async function POST(req: Request) {
  try {
    const presentedSecret = req.headers.get(EMBED_SECRET_HEADER);
    if (!presentedSecret) return deny("missing_embed_secret", 401);

    const body = Body.parse(await req.json());

    const tenant = await db.tenant.findFirst({
      where: { slug: body.tenantSlug, status: "ACTIVE", ...notDeleted },
      select: { id: true, slug: true, embed: true },
    });
    const embed = tenant?.embed;

    // One answer for "no such tenant", "embedding off" and "wrong secret".
    if (!tenant || !embed?.enabled || !embedSecretMatches(presentedSecret, embed.secretHash)) {
      return deny("invalid_tenant_or_secret", 403);
    }

    const origin = normalizeOrigin(body.origin);
    if (!origin || !isOriginAllowed(origin, embed.allowedOrigins)) {
      return deny("origin_not_allowed", 403);
    }

    let user;
    try {
      user = await requireTenantUser(tenant.id, body.userId, { statuses: ["ACTIVE"] });
    } catch (err) {
      if (err instanceof TenantScopeError) return deny("user_not_in_tenant", 403);
      throw err;
    }

    const role = resolveEmbedRole(user.role, body.role);
    if (!role) return deny("role_not_permitted", 403);

    const ttlSeconds = body.ttlSeconds ?? 600;
    const token = await signEmbedToken(
      { tenantId: tenant.id, tenantSlug: tenant.slug, userId: user.id, role, origin },
      ttlSeconds,
    );

    await audit({
      tenantId: tenant.id,
      actorId: user.id,
      actorEmail: user.email,
      action: "embed.token.mint",
      entity: "User",
      entityId: user.id,
      after: { role, origin, ttlSeconds },
    });

    return ok({ token, expiresIn: ttlSeconds, role }, NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}

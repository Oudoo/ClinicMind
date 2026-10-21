import { getActingContext } from "@/lib/auth/session";
import { permissionsFor } from "@/lib/auth/rbac";
import { ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Current acting context for the embedded/dashboard client. */
export async function GET(req: Request) {
  const ctx = await getActingContext(req);
  if (!ctx) return unauthorized();
  return ok({
    tenant: { id: ctx.tenantId, slug: ctx.tenantSlug, name: ctx.tenantName },
    user: { id: ctx.userId, email: ctx.email, fullName: ctx.fullName, role: ctx.role },
    auth: ctx.auth.method,
    permissions: permissionsFor(ctx.role),
  });
}

import { getActingContext } from "@/lib/auth/session";
import { permissionsFor } from "@/lib/auth/rbac";
import { ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Current acting context for the embedded/dashboard client. */
export async function GET() {
  const ctx = await getActingContext();
  if (!ctx) return unauthorized();
  return ok({
    tenant: { id: ctx.tenantId, slug: ctx.tenantSlug, name: ctx.tenantName },
    user: { id: ctx.userId, email: ctx.email, role: ctx.role },
    permissions: permissionsFor(ctx.role),
  });
}

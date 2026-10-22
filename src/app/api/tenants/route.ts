import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { ProvisionInput } from "@/modules/platform/dto";
import { handlePlatformError } from "@/modules/platform/http";
import { listTenants, provisionTenant } from "@/modules/platform/service";

export const dynamic = "force-dynamic";

/**
 * Provision a new tenant (client instance). Requires `platform:manage`, which
 * only SUPER_ADMIN holds — a clinic owner's `tenant:manage` covers their own
 * tenant's settings, never the platform. Creates the tenant, its embed config
 * (with a freshly generated embed secret), a default clinic and the owner user
 * in one transaction so a new client gets a fully isolated, ready-to-embed
 * ClinicMind. The owner is created INVITED and receives an invitation link to
 * set their password; the link is also returned to the caller. The embed secret
 * is returned once, in this response only.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");

    const input = ProvisionInput.parse(await req.json());
    const result = await provisionTenant(input, { userId: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return handlePlatformError(err);
  }
}

/** List every client tenant on the platform. SUPER_ADMIN only (`platform:manage`). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");
    return ok({ tenants: await listTenants() });
  } catch (err) {
    return handlePlatformError(err);
  }
}

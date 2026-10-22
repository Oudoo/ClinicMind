import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { notFound, ok, unauthorized } from "@/lib/api";
import { TenantPatchInput } from "@/modules/platform/dto";
import { getTenantDetail, updateTenant } from "@/modules/platform/service";
import { handlePlatformError } from "@/modules/platform/http";

export const dynamic = "force-dynamic";

/** One client tenant with its clinics, users and usage. `platform:manage` only. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");
    const tenant = await getTenantDetail(id);
    return tenant ? ok({ tenant }) : notFound("tenant");
  } catch (err) {
    return handlePlatformError(err);
  }
}

/**
 * Update a client tenant: name, ACTIVE/SUSPENDED status, branding, custom
 * domain and its verification, embed origins and switch. `platform:manage` only.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "platform:manage");
    const patch = TenantPatchInput.parse(await req.json());
    const tenant = await updateTenant(id, patch, { userId: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ tenant });
  } catch (err) {
    return handlePlatformError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { BrandingInput } from "@/modules/platform/dto";
import { updateOwnBranding } from "@/modules/platform/service";
import { handlePlatformError } from "@/modules/platform/http";

export const dynamic = "force-dynamic";

/**
 * White-label the acting tenant: product name, accent colour and logo.
 * `tenant:manage` (the clinic owner) on their own tenant only; the platform
 * console edits any tenant through PATCH /api/tenants/[id].
 */
export async function PATCH(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const patch = BrandingInput.parse(await req.json());
    const branding = await updateOwnBranding(ctx.tenantId, patch, { userId: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ branding });
  } catch (err) {
    return handlePlatformError(err);
  }
}

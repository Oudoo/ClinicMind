import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { updateCampaign } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "@/app/api/leads/_lib/errors";

export const dynamic = "force-dynamic";

/** `PATCH /api/campaigns/[id]` — edit name, platform id, platform, source, treatment, active, dates (blank clears). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const campaign = await updateCampaign(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ campaign });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

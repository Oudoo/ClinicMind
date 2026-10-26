import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { addCampaignCost } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "@/app/api/leads/_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/campaigns/[id]/costs` { periodStart, periodEnd, amount } → 201 `{ cost }` (whole EGP). */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const cost = await addCampaignCost(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ cost }, { status: 201 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

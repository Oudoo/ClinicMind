import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createCampaign, listCampaigns } from "@/modules/crm/service";
import { actorOf, crmErrorResponse } from "@/app/api/leads/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/campaigns` → `{ campaigns }` with lead / consultation / won counts and the total cost (leads:read). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:read");
    return ok({ campaigns: await listCampaigns(ctx.tenantId) });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `POST /api/campaigns` { externalId, name, platform, source?, treatmentId?, active?, startedAt?, endedAt? }
 * → 201 `{ campaign }`; 409 `duplicate_external_id` (leads:write).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const campaign = await createCampaign(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ campaign }, { status: 201 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

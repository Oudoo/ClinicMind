import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { importCampaignCosts } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "@/app/api/leads/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/campaigns/[id]/costs/import` { csv, commit? } → `{ rows, errors, imported }`.
 * Rows are `periodStart,periodEnd,amount`; without `commit` the parsed rows are
 * previewed, with it they are written (422 listing bad lines when any exist).
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const result = await importCampaignCosts(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok(result, { status: result.imported ? 201 : 200 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

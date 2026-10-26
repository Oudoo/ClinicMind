import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { reopenLead } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/leads/[id]/reopen` → `{ lead }` back in the stage it was lost at; 409 `not_lost`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const lead = await reopenLead(ctx.tenantId, id, actorOf(ctx, req));
    return ok({ lead });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

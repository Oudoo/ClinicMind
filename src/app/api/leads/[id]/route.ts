import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { getLead, updateLead } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/leads/[id]` → `{ lead }` with follow-ups, conversations, patient and consultation; foreign ids are 404. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:read");
    const lead = await getLead(ctx.tenantId, id);
    if (!lead) return notFound("lead");
    return ok({ lead });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `PATCH /api/leads/[id]` — edit contact details, source, campaign, interests, owner, notes (blank clears). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const lead = await updateLead(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ lead });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

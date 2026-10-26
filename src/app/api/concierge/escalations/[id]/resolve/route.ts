import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { resolveEscalation } from "@/modules/concierge/escalations";
import { conciergeContext, jsonBody, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/escalations/[id]/resolve` with `{ resolution }` (what
 * was done; required) → `{ escalation }`. Resolving an unacknowledged one
 * acknowledges it at the same moment. 422 without a note, 409 when already
 * resolved.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    return ok({ escalation: await resolveEscalation(c.ctx.tenantId, id, await jsonBody(req), c.actor) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

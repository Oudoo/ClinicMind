import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { retireProtocol } from "@/modules/concierge/service";
import { conciergeContext, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/protocols/[id]/retire` — ACTIVE → RETIRED. Running
 * enrolments keep their version; newly signed procedures of the treatment are
 * not enrolled until a new version is approved. → `{ protocol }`; 409
 * `active_only`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    return ok({ protocol: await retireProtocol(c.ctx.tenantId, id, c.actor) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

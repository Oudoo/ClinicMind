import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { acknowledgeEscalation } from "@/modules/concierge/escalations";
import { conciergeContext, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/escalations/[id]/acknowledge` — "I have it": OPEN →
 * ACKNOWLEDGED, stamped with who and when (the acknowledgement KPI compares
 * it with the 15 / 30-minute target). → `{ escalation }`; 409 when it is not
 * open any more (someone else took it).
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    return ok({ escalation: await acknowledgeEscalation(c.ctx.tenantId, id, c.actor) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

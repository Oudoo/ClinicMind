import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { getEnrolmentDetail, pauseEnrolment } from "@/modules/concierge/service";
import { conciergeContext, jsonBody, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/concierge/enrolments/[id]/pause` with `{ reason? }`: ACTIVE → PAUSED (nothing new goes out; links already sent stay answerable). 409 `invalid_state` otherwise. → `{ enrolment }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    await pauseEnrolment(c.ctx.tenantId, id, await jsonBody(req), c.actor);
    return ok({ enrolment: await getEnrolmentDetail(c.ctx.tenantId, id) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

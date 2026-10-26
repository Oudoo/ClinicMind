import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { getEnrolmentDetail, resumeEnrolment } from "@/modules/concierge/service";
import { conciergeContext, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/concierge/enrolments/[id]/resume`: PAUSED → ACTIVE (steps more than a day late are skipped, not sent). 409 `invalid_state` otherwise. → `{ enrolment }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    await resumeEnrolment(c.ctx.tenantId, id, c.actor);
    return ok({ enrolment: await getEnrolmentDetail(c.ctx.tenantId, id) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

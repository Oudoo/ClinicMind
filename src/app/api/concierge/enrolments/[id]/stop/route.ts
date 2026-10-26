import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { getEnrolmentDetail, stopEnrolment } from "@/modules/concierge/service";
import { conciergeContext, jsonBody, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/concierge/enrolments/[id]/stop` with `{ reason }` (required): pending steps and unanswered check-ins are skipped and their links stop working. 422 without a reason, 409 when already stopped or completed. → `{ enrolment }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    await stopEnrolment(c.ctx.tenantId, id, await jsonBody(req), c.actor);
    return ok({ enrolment: await getEnrolmentDetail(c.ctx.tenantId, id) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

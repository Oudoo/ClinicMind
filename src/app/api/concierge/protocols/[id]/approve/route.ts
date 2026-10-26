import { handleApiError, ok, unauthorized } from "@/lib/api";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { approveProtocol } from "@/modules/concierge/service";
import { conciergeContext, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/protocols/[id]/approve` — DRAFT → ACTIVE; the previous
 * active version of the treatment retires (running enrolments keep theirs).
 * A protocol sets clinical thresholds, so approving also needs a clinician's
 * signing right (`consultations:sign`: doctors and the owner). → `{ protocol }`;
 * 409 `draft_only`, 422 `no_steps`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    assertCan(c.ctx.role, "consultations:sign");
    return ok({ protocol: await approveProtocol(c.ctx.tenantId, id, c.actor) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

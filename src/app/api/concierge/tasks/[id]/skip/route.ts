import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { skipTask } from "@/modules/concierge/service";
import { conciergeContext, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/tasks/[id]/skip` — a pending step never goes out; a
 * sent one's link stops working. → `{ task: { id, status } }`; 409 when the
 * step is already answered, missed or skipped.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    const task = await skipTask(c.ctx.tenantId, id, c.actor);
    return ok({ task: { id: task.id, status: task.status } });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

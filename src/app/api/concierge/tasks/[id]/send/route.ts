import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { sendTaskNow } from "@/modules/concierge/dispatch";
import { conciergeContext, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/tasks/[id]/send` — send this step again now, whatever
 * the schedule (a fresh link; the previous one stops working). → `{ task:
 * { id, status, sentAt, attempts }, delivery, conversationId }`. 409 when the
 * step is answered or the enrolment is stopped or completed. The link itself
 * is never returned: it travels in the message only.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    const result = await sendTaskNow(c.ctx.tenantId, id, c.actor);
    return ok({
      task: { id: result.task.id, status: result.task.status, sentAt: result.task.sentAt?.toISOString() ?? null, attempts: result.task.attempts, lastError: result.task.lastError },
      delivery: result.delivery,
      conversationId: result.conversationId,
    });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

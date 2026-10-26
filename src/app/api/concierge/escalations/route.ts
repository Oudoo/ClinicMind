import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listEscalations } from "@/modules/concierge/escalations";
import { conciergeContext } from "../_lib/context";
import { conciergeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/concierge/escalations?status=OPEN|ACKNOWLEDGED|RESOLVED|open&level&enrolmentId&assignedToId&page&pageSize`
 * → `{ escalations, total, page, pageSize }`, most urgent target first
 * (`status=open` = OPEN or ACKNOWLEDGED; resolved ones newest first).
 */
export async function GET(req: Request) {
  try {
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    return ok(await listEscalations(c.ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

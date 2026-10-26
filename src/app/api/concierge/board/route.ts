import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getBoard } from "@/modules/concierge/service";
import { conciergeContext } from "../_lib/context";
import { conciergeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/concierge/board` → `{ board }`: open escalations (OPEN by target,
 * then ACKNOWLEDGED), check-ins due today, sent and awaiting an answer,
 * answered today with their triage, who is on call now, and the KPIs of the
 * last 30 days (answer rate vs 90 %, high-risk acknowledged within target vs
 * 100 % with the median minutes). The board page polls it.
 */
export async function GET(req: Request) {
  try {
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    return ok({ board: await getBoard(c.ctx.tenantId) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

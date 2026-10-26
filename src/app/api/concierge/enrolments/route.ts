import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listEnrolments } from "@/modules/concierge/service";
import { conciergeContext } from "../_lib/context";
import { conciergeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/concierge/enrolments?status&treatmentId&patientId&q&page&pageSize`
 * → `{ enrolments, total, page, pageSize, counts }` (newest procedure first;
 * `counts` per status under the same filters; `q` matches the patient's name
 * or phone).
 */
export async function GET(req: Request) {
  try {
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    const query = Object.fromEntries(new URL(req.url).searchParams);
    return ok(await listEnrolments(c.ctx.tenantId, query));
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

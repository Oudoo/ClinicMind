import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { can } from "@/lib/auth/rbac";
import { getEnrolmentDetail } from "@/modules/concierge/service";
import { conciergeContext, type IdParams } from "../../_lib/context";
import { conciergeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/concierge/enrolments/[id]` → `{ enrolment }`: patient, procedure,
 * protocol version, every task with its status and answers (photo ids for
 * `/api/concierge/files/[id]`), and the enrolment's escalations. Staff who can
 * act (`concierge:write`) also get each step's last message as sent. A
 * foreign tenant's id is a 404.
 */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    const enrolment = await getEnrolmentDetail(c.ctx.tenantId, id, new Date(), { messages: can(c.ctx.role, "concierge:write") });
    if (!enrolment) return notFound("enrolment");
    return ok({ enrolment });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

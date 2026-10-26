import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { convertLead } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/leads/[id]/convert` { patientId?, referredBy?, language? } →
 * 201 `{ leadId, patient, created }`. Creates the patient from the lead or
 * links the given one; 409 `already_converted`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const result = await convertLead(ctx.tenantId, id, await req.json().catch(() => ({})), actorOf(ctx, req));
    return ok(result, { status: 201 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

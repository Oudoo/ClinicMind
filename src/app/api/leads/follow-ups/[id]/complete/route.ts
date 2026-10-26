import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { completeFollowUp } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/leads/follow-ups/[id]/complete` { outcome } → `{ followUp }`; resolves its escalation. 409 `follow_up_done`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const followUp = await completeFollowUp(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ followUp });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

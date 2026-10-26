import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { changeStage } from "@/modules/crm/service";
import { actorOf, crmErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/** `POST /api/leads/[id]/stage` { stage } → `{ lead }`; 409 `invalid_stage` when the pipeline forbids the move. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const lead = await changeStage(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ lead });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

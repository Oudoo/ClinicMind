import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { updateRecallRule } from "@/modules/recalls/rules";
import { actorOf, recallErrorResponse, type Params } from "../../recalls/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `PATCH /api/recall-rules/[id]` — any of the rule's fields (the whole rule is checked again)
 * → `{ rule }`. Applies to the recalls made from then on. The owner only.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:manage");
    return ok({ rule: await updateRecallRule(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req)) });
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { bookRecall } from "@/modules/recalls/service";
import { actorOf, recallErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/recalls/[id]/book` `{ doctorId, startsAt, endsAt, clinicId?, room?, reason? }`
 * → 201 `{ recall, appointment }`. Books through the appointments service (409
 * `conflict` with the slots in the way, 422 `outside_hours` / `in_the_past`) and
 * marks the recall booked.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:write");
    assertCan(ctx.role, "appointments:write");
    return ok(await bookRecall(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req)), { status: 201 });
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

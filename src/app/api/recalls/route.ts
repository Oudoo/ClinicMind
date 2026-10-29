import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { addRecall, listRecalls } from "@/modules/recalls/service";
import { actorOf, recallErrorResponse } from "./_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/recalls?tab=today|soon|booked|all&status=&kind=&owner=mine|all&q=&patientId=&page=&pageSize=`
 * → `{ recalls, total, page, pageSize, counts: { today, soon, booked } }`.
 * Today: who to contact today, most urgent first (see modules/recalls/service.ts).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:read");
    const query = Object.fromEntries(new URL(req.url).searchParams);
    return ok(await listRecalls(ctx.tenantId, query, { userId: ctx.userId, role: ctx.role }));
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/recalls` `{ patientId, label, dueOn: "YYYY-MM-DD", windowDays?, ownerRole?, channel?, note? }`
 * → 201 `{ recall }`: a review no rule makes, added by hand.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:write");
    const recall = await addRecall(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ recall }, { status: 201 });
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

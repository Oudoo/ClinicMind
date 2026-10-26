import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listReviewSnapshots, recordReviewSnapshot } from "@/modules/reporting/reviews";

export const dynamic = "force-dynamic";

/** `GET /api/reviews/snapshots` → `{ snapshots }` (newest first, 26 weeks). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "reports:read");
    return ok({ snapshots: await listReviewSnapshots(ctx.tenantId) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `POST /api/reviews/snapshots` `{ weekStart: YYYY-MM-DD, count, rating }` — manual entry, owner only. 201 `{ snapshot }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const snapshot = await recordReviewSnapshot(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ snapshot }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}

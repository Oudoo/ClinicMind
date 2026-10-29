import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createRecallRule, listRecallRules } from "@/modules/recalls/rules";
import { actorOf, recallErrorResponse } from "../recalls/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/recall-rules` → `{ rules }` (the clinic's four defaults the first time). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:read");
    return ok({ rules: await listRecallRules(ctx.tenantId) });
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/recall-rules` `{ name, kind: SESSIONS|REVIEWS, treatmentId?, diagnosisTerms?, dueDays, windowDays?,
 * sessions?, ownerRole?, ownerId?, channel?, active? }` → 201 `{ rule }`. The owner only.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:manage");
    const rule = await createRecallRule(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ rule }, { status: 201 });
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

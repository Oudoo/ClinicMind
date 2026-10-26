import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { FollowUpListQuery, followUpCounts, listFollowUps } from "@/modules/crm/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/leads/follow-ups?scope=due|overdue|mine` → `{ followUps, counts }`.
 * `due` is today on the clinic clock, `overdue` everything past its time,
 * `mine` the acting user's open follow-ups.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:read");
    const { scope } = FollowUpListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    const [followUps, counts] = await Promise.all([listFollowUps(ctx.tenantId, scope, ctx.userId), followUpCounts(ctx.tenantId, ctx.userId)]);
    return ok({ scope, followUps, counts });
  } catch (err) {
    return handleApiError(err);
  }
}

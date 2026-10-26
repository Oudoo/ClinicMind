import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { buildWeeklyBrief, getBriefState } from "@/modules/reporting/brief";

export const dynamic = "force-dynamic";

/** `GET /api/reports/brief` → `{ brief, state }`: this week's brief (the five largest changes) and when it was last sent. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "reports:read");
    const [brief, state] = await Promise.all([buildWeeklyBrief(ctx.tenantId, new Date(), { canSeeRevenue: can(ctx.role, "finance:read") }), getBriefState(ctx.tenantId)]);
    return ok({ brief, state });
  } catch (err) {
    return handleApiError(err);
  }
}

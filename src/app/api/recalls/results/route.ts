import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getTenantTimezone } from "@/modules/appointments/service";
import { resolvePeriod } from "@/modules/reporting/period";
import { recallResults } from "@/modules/recalls/results";

export const dynamic = "force-dynamic";

/**
 * `GET /api/recalls/results?period=month|today|7d|28d|90d|custom&from=&to=` →
 * `{ period: { fromKey, toKey, previous }, results }`: how the recalls due in
 * the period did, against the period before (this month by default). The
 * revenue from recalls is the finance roles' only (null for the others).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:read");
    const q = new URL(req.url).searchParams;
    const tz = await getTenantTimezone(ctx.tenantId);
    const period = resolvePeriod({ period: q.get("period"), from: q.get("from"), to: q.get("to") }, tz, new Date(), "month");
    const results = await recallResults(ctx.tenantId, period, { withRevenue: can(ctx.role, "finance:read") });
    return ok({ period: { fromKey: period.fromKey, toKey: period.toKey, previous: { from: period.previous.from.toISOString(), to: period.previous.to.toISOString() } }, results });
  } catch (err) {
    return handleApiError(err);
  }
}

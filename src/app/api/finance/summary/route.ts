import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getFinanceSummary } from "@/modules/finance/service";
import { periodFromSearchParams } from "@/modules/reporting/query";

export const dynamic = "force-dynamic";

/** `GET /api/finance/summary?period=28d|today|7d|month|90d|custom&from&to` → the finance dashboard figures (`finance:read`). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "finance:read");
    const timeZone = await getTenantTimezone(ctx.tenantId);
    const period = periodFromSearchParams(new URL(req.url).searchParams, timeZone);
    const summary = await getFinanceSummary(ctx.tenantId, period, timeZone);
    return ok({ period: { preset: period.preset, from: period.from, to: period.to, fromKey: period.fromKey, toKey: period.toKey, days: period.days }, summary });
  } catch (err) {
    return handleApiError(err);
  }
}

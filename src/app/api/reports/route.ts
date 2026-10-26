import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parseReportQuery } from "@/modules/reporting/query";
import { getReport } from "@/modules/reporting/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/reports?period=28d|today|7d|month|90d|custom&from&to&doctorId&treatment&source`
 * → `{ report }` with every metric (M1–M13) for the period and its comparison
 * period (`reports:read`). Revenue figures are stripped for roles without
 * `finance:read` (`report.redacted`).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "reports:read");
    const query = parseReportQuery(Object.fromEntries(new URL(req.url).searchParams));
    const report = await getReport(ctx.tenantId, query, { canSeeRevenue: can(ctx.role, "finance:read") });
    return ok({ report });
  } catch (err) {
    return handleApiError(err);
  }
}

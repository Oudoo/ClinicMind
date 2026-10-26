import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parseReportQuery } from "@/modules/reporting/query";
import { getReport } from "@/modules/reporting/service";
import { listTargets, targetRows, upsertTarget } from "@/modules/reporting/targets";

export const dynamic = "force-dynamic";

/** `GET /api/reports/targets?period…` → `{ targets }`: baseline, target, unit, due date and the current value per metric. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "reports:read");
    const query = parseReportQuery(Object.fromEntries(new URL(req.url).searchParams));
    const [rows, report] = await Promise.all([listTargets(ctx.tenantId), getReport(ctx.tenantId, query, { canSeeRevenue: can(ctx.role, "finance:read") })]);
    return ok({ targets: targetRows(rows, report) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `PUT /api/reports/targets` `{ metric, baseline, target, unit, dueAt }` — owner only (`tenant:manage`). → `{ target }`. */
export async function PUT(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const target = await upsertTarget(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ target });
  } catch (err) {
    return handleApiError(err);
  }
}

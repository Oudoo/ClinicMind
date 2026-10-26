import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createAlertRule, listAlertRules } from "@/modules/reporting/alerts";

export const dynamic = "force-dynamic";

/** `GET /api/alert-rules` → `{ rules }` (`reports:read`; a revenue rule's figures are blanked without `finance:read`). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "reports:read");
    return ok({ rules: await listAlertRules(ctx.tenantId, { canSeeRevenue: can(ctx.role, "finance:read") }) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `POST /api/alert-rules` `{ name, metric, comparator, threshold, windowDays?, notifyRoles?, enabled? }` — owner only. 201 `{ rule }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const rule = await createAlertRule(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ rule }, { status: 201 });
  } catch (err) {
    return handleApiError(err);
  }
}

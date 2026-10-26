import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { updateAlertRule } from "@/modules/reporting/alerts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `PATCH /api/alert-rules/[id]` — edit or disable a rule (owner only); a foreign tenant's id is a 404. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const rule = await updateAlertRule(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    if (!rule) return notFound("alert_rule");
    return ok({ rule });
  } catch (err) {
    return handleApiError(err);
  }
}

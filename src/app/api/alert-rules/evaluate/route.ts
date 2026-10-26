import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { evaluateAlertRules } from "@/modules/reporting/alerts";

export const dynamic = "force-dynamic";

/** `POST /api/alert-rules/evaluate` — run every enabled rule now (owner only). → `{ results }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    return ok({ results: await evaluateAlertRules(ctx.tenantId, new Date()) });
  } catch (err) {
    return handleApiError(err);
  }
}

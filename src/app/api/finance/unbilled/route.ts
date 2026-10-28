import { getActingContext } from "@/lib/auth/session";
import { can, RbacError } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listUnbilled } from "@/modules/finance/unbilled";

export const dynamic = "force-dynamic";

/**
 * `GET /api/finance/unbilled?date=YYYY-MM-DD` — the day's work not billed yet
 * (today by default): visits that took place with no procedure, fee or charge,
 * and procedures done that day still waiting to be signed or started. For the
 * front desk (`payments:write`) and the owner (`finance:read`).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) throw new RbacError(`Role ${ctx.role} lacks permission payments:write`);
    const url = new URL(req.url);
    const day = await listUnbilled(ctx.tenantId, { date: url.searchParams.get("date") || undefined });
    return ok(day);
  } catch (err) {
    return handleApiError(err);
  }
}

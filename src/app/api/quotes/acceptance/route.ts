import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { caseAcceptance } from "@/modules/quotes/acceptance";

export const dynamic = "force-dynamic";

/**
 * `GET /api/quotes/acceptance?days=90` (`quotes:read`) → case acceptance over the last `days` days:
 * quotes given, accepted (by count and value), declined, expired and open, quotes expiring within a
 * week, and by treatment; by doctor only for roles that read the clinic's finances (`finance:read`).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:read");
    const days = Number(new URL(req.url).searchParams.get("days")) || 90;
    return ok(await caseAcceptance(ctx.tenantId, { days, byDoctor: can(ctx.role, "finance:read") }));
  } catch (err) {
    return handleApiError(err);
  }
}

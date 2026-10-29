import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { payOverview } from "@/modules/finance/doctor-pay";
import { financeErrorResponse } from "../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/doctor-pay/statements?month=YYYY-MM` (`finance:read`) → `{ month, monthLabel, rows, withoutRules }`: each paid doctor's statement for the month. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "finance:read");
    return ok(await payOverview(ctx.tenantId, new URL(req.url).searchParams.get("month") ?? ""));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

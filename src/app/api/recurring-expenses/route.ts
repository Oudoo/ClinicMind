import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createRecurring, listRecurring } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/recurring-expenses` (`expenses:read`) — those running (the next bill soonest), then those stopped. → `{ recurring }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "expenses:read");
    if (!c) return unauthorized();
    return ok({ recurring: await listRecurring(c.ctx.tenantId, { role: c.ctx.role }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/recurring-expenses` (`tenant:manage`) `{ category, description, amount, everyMonths, dayOfMonth, dueDays?,
 * startMonth, supplierId? | supplierName?, clinicId?, note? }` — its bills already due are made at once. → 201 `{ recurring }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "tenant:manage");
    if (!c) return unauthorized();
    return ok({ recurring: await createRecurring(c.ctx.tenantId, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

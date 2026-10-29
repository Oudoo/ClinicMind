import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getSupplier, updateSupplier } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/suppliers/[id]` (`expenses:read`) → `{ supplier }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "expenses:read");
    if (!c) return unauthorized();
    return ok({ supplier: await getSupplier(c.ctx.tenantId, id, { role: c.ctx.role }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `PATCH /api/suppliers/[id]` (`expenses:write`) `{ name, category, contactName?, phone?, email?, notes?, archived? }` — the details as the form holds them. → `{ supplier }`. */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    return ok({ supplier: await updateSupplier(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

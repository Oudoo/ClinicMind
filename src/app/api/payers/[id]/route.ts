import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getPayer, updatePayer } from "@/modules/insurance/payers";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/payers/[id]` (`insurance:read`) — the payer with its contracts. → `{ payer }`. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    return ok({ payer: await getPayer(c.ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `PATCH /api/payers/[id]` (`insurance:manage`) `{ name, kind, …, archived? }`. → `{ payer }`. */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    return ok({ payer: await updatePayer(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

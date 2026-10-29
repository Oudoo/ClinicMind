import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { voidPayerPayment } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `POST /api/payer-payments/[id]/void` (`insurance:manage`) `{ reason }` — an answer recorded by mistake: its write-offs go with it. → `{ voided: true }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    await voidPayerPayment(c.ctx.tenantId, id, await req.json().catch(() => null), c.actor);
    return ok({ voided: true });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

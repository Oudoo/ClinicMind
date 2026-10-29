import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { recordLabResult } from "@/modules/lab/orders";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { boundedJson, expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/lab-orders/[id]/result` (`lab:write`, clinicians) `{ result, abnormal?, receivedOn?, files? }` — the result
 * as the lab's report has it (recorded again, it is corrected); the doctor who asked is told. → `{ order }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "lab:write");
    if (!c) return unauthorized();
    const read = await boundedJson(req);
    if ("response" in read) return read.response;
    return ok({ order: await recordLabResult(c.ctx.tenantId, id, read.body, c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { answerContext, recordPayerAnswer } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/payer-payments?payerId=&batchId=` (`insurance:manage`) — the payer's claim lines still owed, to answer. → `{ lines }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    const sp = new URL(req.url).searchParams;
    return ok({ lines: await answerContext(c.ctx.tenantId, sp.get("payerId") ?? "", { batchId: sp.get("batchId") ?? undefined }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/payer-payments` (`insurance:manage`) `{ payerId, batchId?, paidOn, method?, reference?, note?, lines: [{
 * claimLineId, paid, refused, reason?, writeOff? }] }` — the payer's answer: what it paid and refused. → 201 `{ result }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    return ok({ result: await recordPayerAnswer(c.ctx.tenantId, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

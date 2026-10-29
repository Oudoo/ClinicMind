import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listBatches, sendClaims } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/claim-batches` (`insurance:read`) `?payerId=&open=1` — batches sent, newest first. → `{ batches }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    const sp = new URL(req.url).searchParams;
    return ok({ batches: await listBatches(c.ctx.tenantId, { payerId: sp.get("payerId") ?? undefined, open: sp.get("open") === "1" }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `POST /api/claim-batches` (`insurance:write`) `{ payerId, clinicId?, claimIds?, upTo?, sentOn?, reference?, note? }` — send a payer's claims not sent yet: a batch for each branch. → 201 `{ batches }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:write");
    if (!c) return unauthorized();
    return ok({ batches: await sendClaims(c.ctx.tenantId, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { giveQuote } from "@/modules/quotes/service";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { actorOf } from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `POST /api/quotes/[id]/give` (`quotes:write`) — give a draft to the patient (to print it): it takes the branch's next quote number and its prices hold until its last valid day. A quote given already: unchanged. → `{ quote }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:write");
    return ok({ quote: await giveQuote(ctx.tenantId, id, actorOf(ctx, req)) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

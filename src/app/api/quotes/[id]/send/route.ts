import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { sendQuote } from "@/modules/quotes/service";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { actorOf } from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `POST /api/quotes/[id]/send` (`quotes:write`) — send the patient a fresh link on WhatsApp (giving a draft first). An expired or closed quote: 409. → `{ link, delivery, conversationId, quote }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:write");
    return ok(await sendQuote(ctx.tenantId, id, actorOf(ctx, req)));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

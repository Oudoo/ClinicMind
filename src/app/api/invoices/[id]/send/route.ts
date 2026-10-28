import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { sendInvoice } from "@/modules/finance/invoices";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `POST /api/invoices/[id]/send` — send the patient their copy on WhatsApp (a fresh link and the totals, in the invoice's language) (`payments:write`). → `{ link, delivery, conversationId }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const actor = { id: ctx.userId, email: ctx.email, ip: clientIp(req) };
    const result = await sendInvoice(ctx.tenantId, id, actor);
    return ok(result);
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

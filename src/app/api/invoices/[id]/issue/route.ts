import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { issueInvoice } from "@/modules/finance/invoices";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `POST /api/invoices/[id]/issue` — issue a draft: the branch's next number (no gaps), today's date, the patient's credit put towards it (`payments:write`). → `{ invoice }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const actor = { id: ctx.userId, email: ctx.email, ip: clientIp(req) };
    const result = await issueInvoice(ctx.tenantId, id, actor);
    return ok({ invoice: result });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

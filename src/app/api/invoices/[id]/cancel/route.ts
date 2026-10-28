import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { cancelInvoice } from "@/modules/finance/invoices";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `POST /api/invoices/[id]/cancel` `{ reason }` — the owner (`tenant:manage`) cancels an issued invoice with a numbered credit note; what was paid on it goes back to the patient's credit. → `{ invoice }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const actor = { id: ctx.userId, email: ctx.email, ip: clientIp(req) };
    const result = await cancelInvoice(ctx.tenantId, id, await req.json().catch(() => null), actor);
    return ok({ invoice: result });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

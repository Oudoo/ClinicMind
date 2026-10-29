import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { writeOffInvoice } from "@/modules/finance/adjustments";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/invoices/[id]/write-off` `{ amount?, reason, note? }` — the
 * owner (`tenant:manage`) writes off what is left on an issued invoice (all
 * of it unless an amount is given), with a reason of the fixed list.
 * → `{ invoice }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const actor = { id: ctx.userId, email: ctx.email, ip: clientIp(req), role: ctx.role };
    return ok({ invoice: await writeOffInvoice(ctx.tenantId, id, await req.json().catch(() => null), actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

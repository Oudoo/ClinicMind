import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { discountDraftLine } from "@/modules/finance/adjustments";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * `POST /api/invoices/[id]/discount` `{ chargeId, amount, reason, note? }` —
 * a discount on a line of a draft invoice, with a reason of the fixed list,
 * within the role's limit for that line (403 `discount_limit` above it: the
 * owner's then). → `{ invoice }`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const actor = { id: ctx.userId, email: ctx.email, ip: clientIp(req), role: ctx.role };
    return ok({ invoice: await discountDraftLine(ctx.tenantId, id, await req.json().catch(() => null), actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

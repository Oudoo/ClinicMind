import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { discardDraft, getInvoice, updateDraft } from "@/modules/finance/invoices";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { assertCanReadInvoices } from "../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/invoices/[id]` → `{ invoice }` with its lines, payments and credit note. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    return ok({ invoice: await getInvoice(ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `PATCH /api/invoices/[id]` `{ language?, note?, removeChargeIds? }` — change a draft (`payments:write`). */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    return ok({ invoice: await updateDraft(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `DELETE /api/invoices/[id]` — discard a draft (it had no number). An issued invoice: 409. */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    await discardDraft(ctx.tenantId, id, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ discarded: true });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

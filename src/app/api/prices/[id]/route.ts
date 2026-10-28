import { NextResponse } from "next/server";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getPriceItem, updatePriceItem } from "@/modules/finance/prices";
import { financeErrorResponse } from "../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/prices/[id]` → `{ item }` with its whole price history. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const item = await getPriceItem(ctx.tenantId, id);
    if (!item) return NextResponse.json({ error: "not_found", entity: "price_item" }, { status: 404 });
    return ok({ item });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** Edit an item (owner): name, category, unit, treatment, course, whether it is offered. The code stays. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "prices:manage");
    const item = await updatePriceItem(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ item });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

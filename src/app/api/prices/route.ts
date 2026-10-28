import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createPriceItem, listPriceList } from "@/modules/finance/prices";
import { financeErrorResponse } from "../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/prices?q&category&at=YYYY-MM-DD&clinicId&includeInactive=1` →
 * `{ items, at, timezone }`: the price list as of a day, for a branch or
 * clinic-wide. Every member of staff can read it.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    return ok(await listPriceList(ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * Add an item (owner, `prices:manage`). Body: `{ code, name, category, unit,
 * unitLabel?, treatmentId, sessions?, sessionItemId?, price, effectiveFrom? }`.
 * 201 `{ item }`; 409 `code_taken`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "prices:manage");
    const item = await createPriceItem(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ item }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

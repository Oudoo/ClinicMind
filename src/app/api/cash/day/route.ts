import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getCashDay, signOffDay } from "@/modules/finance/cash";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { assertCanReadInvoices } from "../../invoices/_lib";

export const dynamic = "force-dynamic";

/**
 * `GET /api/cash/day?date=YYYY-MM-DD&clinicId=` → a branch's day at the
 * drawer (today by default): its shifts with what was expected and counted
 * per method, the money outside them, the totals, and its sign-off.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    return ok(await getCashDay(ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/cash/day` `{ date, clinicId?, note? }` — the owner signs the
 * day off; every shift of it must be closed (409 `shifts_open`). From then on
 * no money is recorded on it or voided from it.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    return ok(await signOffDay(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) }));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

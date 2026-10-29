import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createPlan, instalmentKpis, listPlans } from "@/modules/finance/instalments";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { assertCanReadInvoices } from "../invoices/_lib";

export const dynamic = "force-dynamic";

/**
 * `GET /api/instalments?view=overdue|due|active|completed|cancelled&patientId&q&page&pageSize[&kpis=1]`
 * → `{ plans, total, page, pageSize, kpis? }`: overdue the most days late first, due within a week the
 * soonest first. For the front desk (`payments:write`) and the owner (`finance:read`).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    const params = new URL(req.url).searchParams;
    const [list, kpis] = await Promise.all([listPlans(ctx.tenantId, Object.fromEntries(params)), params.get("kpis") === "1" ? instalmentKpis(ctx.tenantId) : null]);
    return ok({ ...list, ...(kpis ? { kpis } : {}) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/instalments` (`payments:write`) `{ patientId, quoteId?, title, total, downPayment?, count,
 * everyMonths? (1, 2, 3 or 6), firstDue (YYYY-MM-DD), reminderDays? (0–14), note? }` → 201 `{ plan }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const plan = await createPlan(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ plan }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createLabOrder, labKpis, listLabOrders } from "@/modules/lab/orders";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/**
 * `GET /api/lab-orders` (`lab:read`) `?view=late|waiting|back|unbilled|cancelled&labId=&q=&page=` — the lab orders of a
 * list, with the page's figures; results only for the clinicians. → `{ list, kpis }`.
 */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "lab:read");
    if (!c) return unauthorized();
    const query = Object.fromEntries(new URL(req.url).searchParams);
    const [list, kpis] = await Promise.all([listLabOrders(c.ctx.tenantId, query, { role: c.ctx.role }), labKpis(c.ctx.tenantId, { role: c.ctx.role })]);
    return ok({ list, kpis });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/lab-orders` (`lab:write`) `{ patientId, labId | labName, tests, procedureId?, doctorId?, site?, reference?,
 * sentOn?, dueOn?, note? }` — due back by the lab's usual days unless given. → 201 `{ order }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "lab:write");
    if (!c) return unauthorized();
    return ok({ order: await createLabOrder(c.ctx.tenantId, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

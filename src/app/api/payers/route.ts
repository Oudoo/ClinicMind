import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createPayer, listPayers } from "@/modules/insurance/payers";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/payers` (`insurance:read`) `?archived=1` — insurers and companies, with what each owes and its contract today. → `{ payers }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    const archived = new URL(req.url).searchParams.get("archived") === "1";
    return ok({ payers: await listPayers(c.ctx.tenantId, { archived }) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `POST /api/payers` (`insurance:manage`) `{ name, kind, contactName?, phone?, email?, address?, paymentDays?, notes? }`. → 201 `{ payer }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "insurance:manage");
    if (!c) return unauthorized();
    return ok({ payer: await createPayer(c.ctx.tenantId, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

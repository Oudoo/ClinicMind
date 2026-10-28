import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getLedger } from "@/modules/finance/ledger";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { assertCanReadInvoices } from "../../../invoices/_lib";

export const dynamic = "force-dynamic";

/**
 * `GET /api/patients/[id]/ledger?from=YYYY-MM-DD&to=YYYY-MM-DD&family=1` →
 * the patient's account for the period (every line when no dates are given):
 * `{ patient, scope, family, timezone, from, to, opening, entries, closing,
 * totals, position }`. Each entry carries the balance after it; `family=1`
 * gives the family's account when the patient is in one. For the front desk
 * and the owner, like invoices.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    return ok(await getLedger(ctx.tenantId, id, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

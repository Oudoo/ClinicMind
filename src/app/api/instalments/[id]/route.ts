import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getPlan } from "@/modules/finance/instalments";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { assertCanReadInvoices } from "../../invoices/_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/instalments/[id]` → `{ plan }` with its schedule, where each instalment stands and the payments towards it. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    return ok({ plan: await getPlan(ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listBillable } from "@/modules/finance/invoices";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { assertCanReadInvoices } from "../_lib";

export const dynamic = "force-dynamic";

/** `GET /api/invoices/billable?patientId=` → the patient's charges on no invoice yet: `{ charges, total }`. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    const patientId = new URL(req.url).searchParams.get("patientId") ?? "";
    return ok(await listBillable(ctx.tenantId, patientId));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

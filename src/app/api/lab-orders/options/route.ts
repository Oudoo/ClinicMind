import { handleApiError, ok, unauthorized } from "@/lib/api";
import { labOrderOptions } from "@/modules/lab/orders";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/lab-orders/options?patientId=` (`lab:write`) — the labs, the patient's procedures of the last six months, the doctors. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "lab:write");
    if (!c) return unauthorized();
    const patientId = new URL(req.url).searchParams.get("patientId") ?? "";
    return ok(await labOrderOptions(c.ctx.tenantId, patientId));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

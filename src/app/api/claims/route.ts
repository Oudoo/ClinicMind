import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listClaims } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/claims` (`insurance:read`) `?view=open|sent|settled|cancelled|all&payerId=&q=&page=` — claims, with what is owed. → `{ claims }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    return ok({ claims: await listClaims(c.ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

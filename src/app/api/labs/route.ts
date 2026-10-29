import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listLabs } from "@/modules/lab/orders";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/labs` (`lab:read`) — the labs the clinic sends to, with their usual days. → `{ labs }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "lab:read");
    if (!c) return unauthorized();
    return ok({ labs: await listLabs(c.ctx.tenantId) });
  } catch (err) {
    return handleApiError(err);
  }
}

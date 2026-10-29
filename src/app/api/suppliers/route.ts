import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createSupplier, listSuppliers } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { expenseContext } from "../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/suppliers` (`expenses:read`) `?q=&archived=1` — the suppliers by name, with what is owed to each. → `{ suppliers }`. */
export async function GET(req: Request) {
  try {
    const c = await expenseContext(req, "expenses:read");
    if (!c) return unauthorized();
    const sp = new URL(req.url).searchParams;
    const suppliers = await listSuppliers(c.ctx.tenantId, { role: c.ctx.role, includeArchived: sp.get("archived") === "1", q: sp.get("q")?.trim() || undefined });
    return ok({ suppliers });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `POST /api/suppliers` (`expenses:write`) `{ name, category?, contactName?, phone?, email?, notes? }` — 409 when the name is taken. → 201 `{ supplier }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    return ok({ supplier: await createSupplier(c.ctx.tenantId, await req.json().catch(() => null), c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

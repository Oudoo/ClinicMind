import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createProcedure, listProcedures, ProcedureListQuery } from "@/modules/finance/procedures";
import { financeErrorResponse } from "./_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/procedures?patientId&doctorId&treatmentId&treatmentKey&status&from&to&page&pageSize` → `{ procedures, total, page, pageSize }`. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    const query = ProcedureListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok(await listProcedures(ctx.tenantId, query));
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * Record a procedure (PLANNED). Body: `{ patientId, treatmentId, doctorId?, appointmentId?,
 * performedAt, price, discount?, notes?, deposit?: { amount, method?, paidAt?, reference? } }`.
 * A deposit in the same call needs `payments:write`. 201 `{ procedure }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");
    const body = (await req.json().catch(() => null)) as { deposit?: unknown } | null;
    if (body && typeof body === "object" && body.deposit) assertCan(ctx.role, "payments:write");
    const procedure = await createProcedure(ctx.tenantId, body, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ procedure }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

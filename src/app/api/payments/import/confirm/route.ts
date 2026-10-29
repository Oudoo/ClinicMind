import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { confirmImport } from "@/modules/finance/imports";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/payments/import/confirm` `{ rows: [{ patientId, paidAt, amount, kind, method?, reference?, note? }] }`
 * — create the confirmed rows as payments under one `importBatchId` (audited); rows whose reference is
 * already on file are skipped; 409 `day_closed` when rows fall on a day signed off. 201 `{ importBatchId, created, skipped }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const result = await confirmImport(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok(result, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

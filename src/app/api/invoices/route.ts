import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createDraft, listInvoices } from "@/modules/finance/invoices";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { assertCanReadInvoices } from "./_lib";

export const dynamic = "force-dynamic";

/** `GET /api/invoices?patientId&status&q&page&pageSize` → `{ invoices, total, page, pageSize }` (front desk and owner). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    return ok(await listInvoices(ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/invoices` `{ patientId, chargeIds?, language?, note? }` — a draft
 * from the patient's unbilled charges (those given, or all of one branch's)
 * (`payments:write`). 201 `{ invoice }`; 409 `nothing_to_bill` or `not_billable`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const invoice = await createDraft(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ invoice }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan, can, RbacError } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listPayments, PaymentListQuery, recordPayment } from "@/modules/finance/payments";
import { financeErrorResponse } from "../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/payments?patientId&procedureId&kind&method&from&to&includeVoided&page&pageSize`
 * → `{ payments, total, page, pageSize }`. Open to the roles that record
 * payments and to the owner (finance:read); read-only roles are refused.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) {
      throw new RbacError(`Role ${ctx.role} lacks permission payments:write`);
    }
    const query = PaymentListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok(await listPayments(ctx.tenantId, query));
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * Record a payment (`payments:write`; a refund only the owner, `tenant:manage`,
 * with the reason in `note`). Body: `{ patientId, kind, method?, amount,
 * paidAt?, procedureId?, appointmentId?, reference?, note? }`. 201 `{ payment }`
 * with its receipt number; money in goes towards the patient's open invoices.
 * Amounts of 10,000 EGP or more notify the clinic owner.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const body = await req.json().catch(() => null);
    // Money going back out is the owner's to give.
    if (body && typeof body === "object" && (body as { kind?: unknown }).kind === "REFUND" && !can(ctx.role, "tenant:manage")) {
      throw new RbacError("Only the clinic owner refunds money");
    }
    const payment = await recordPayment(ctx.tenantId, body, { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ payment }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

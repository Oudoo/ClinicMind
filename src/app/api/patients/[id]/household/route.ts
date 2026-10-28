import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getHousehold, setHouseholdHead } from "@/modules/finance/household";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { assertCanReadInvoices } from "../../../invoices/_lib";

export const dynamic = "force-dynamic";

/** `GET /api/patients/[id]/household` → `{ role, head, members, familyBalance }`. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanReadInvoices(ctx.role);
    return ok(await getHousehold(ctx.tenantId, id));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `PUT /api/patients/[id]/household` body `{ headId, relation? }`: the family
 * member who pays for this patient (`headId: null` takes them out of the
 * family). 409 `head_is_member` when the head chosen is paid for by someone
 * else, `pays_for_others` when this patient heads a family, `archived` for an
 * archived patient. For whoever takes payments.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    const body: unknown = await req.json().catch(() => null);
    return ok(await setHouseholdHead(ctx.tenantId, id, body, { id: ctx.userId, email: ctx.email, ip: clientIp(req) }));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { payDoctors, savePayRule } from "@/modules/finance/doctor-pay";
import { financeErrorResponse } from "../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/doctor-pay/rules` (`finance:read`) → `{ doctors }`: everyone paid for work (the owner, doctors, nurses), with their rules. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "finance:read");
    return ok({ doctors: await payDoctors(ctx.tenantId) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/doctor-pay/rules` (`tenant:manage`) `{ doctorId, category ("*", "consultation" or a price-list
 * category), basis (BILLED | COLLECTED | FIXED), percent? (0–100), amount? (EGP a session), deductCosts?, note? }`
 * — set the doctor's rule for the category, replacing the one there was. → `{ rule }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const rule = await savePayRule(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ rule });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

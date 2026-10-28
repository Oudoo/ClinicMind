import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { CliniciansQuery, listStaff } from "@/modules/appointments/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/appointments/clinicians?kind=CONSULTATION|FOLLOW_UP|PROCEDURE|CHECK_UP`
 * → `{ staff: [{ id, fullName, role }] }`.
 *
 * Who a booking of that kind can be made with (the doctor pickers): active
 * staff the owner marked as clinicians, plus the nurses when the kind is
 * PROCEDURE (nurse-led sessions). Never a non-clinical owner-level account.
 * 422 for an unknown kind.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const q = CliniciansQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok({ staff: await listStaff(ctx.tenantId, { kind: q.kind }) });
  } catch (err) {
    return handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { getNextAppointment, NextAppointmentQuery } from "@/modules/appointments/service";
import { nextWithBalances } from "@/modules/finance/ledger";
import { nextWithRecalls } from "@/modules/recalls/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/appointments/next?scope=auto|mine|clinic&patientId=` →
 * `{ appointment, queue, scope, fallback, timezone, now }`.
 *
 * The next live appointment and the rest of today's queue (three deep). With
 * the default scope a doctor or the owner gets their own next booking (and the
 * clinic's when they have none); reception, nurses and assistants get the
 * clinic's. `patientId` (proven to belong to the tenant) returns that
 * patient's next booking and their following ones instead. For the roles that
 * take payments, each appointment carries its patient's balance; with it come
 * the recalls of the next one's visit (what it is booked for, what else is due).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const q = NextAppointmentQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    if (q.patientId) await requireTenantPatient(ctx.tenantId, q.patientId);
    const next = await getNextAppointment(ctx.tenantId, { userId: ctx.userId, role: ctx.role, scope: q.scope, patientId: q.patientId });
    return ok(await nextWithRecalls(ctx.tenantId, ctx.role, await nextWithBalances(ctx.tenantId, ctx.role, next)));
  } catch (err) {
    return handleApiError(err);
  }
}

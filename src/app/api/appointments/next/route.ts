import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { getNextAppointment, NextAppointmentQuery } from "@/modules/appointments/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/appointments/next?scope=auto|mine|clinic&patientId=` →
 * `{ appointment, queue, scope, fallback, timezone, now }`.
 *
 * The next live appointment and the rest of today's queue (three deep). With
 * the default scope a doctor or the owner gets their own next booking (and the
 * clinic's when they have none); reception, nurses and assistants get the
 * clinic's. `patientId` (proven to belong to the tenant) returns that
 * patient's next booking and their following ones instead.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    const q = NextAppointmentQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    if (q.patientId) await requireTenantPatient(ctx.tenantId, q.patientId);
    return ok(await getNextAppointment(ctx.tenantId, { userId: ctx.userId, role: ctx.role, scope: q.scope, patientId: q.patientId }));
  } catch (err) {
    return handleApiError(err);
  }
}

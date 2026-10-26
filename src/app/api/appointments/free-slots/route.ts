import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { findFreeSlots } from "@/modules/appointments/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/appointments/free-slots?doctorId=&date=YYYY-MM-DD&duration=30&room=&after=&excludeId=`
 * → `{ date, timezone, hours, closed, stepMinutes, durationMinutes, slots, free, suggestions }`.
 *
 * The free start times of the day on a 15-minute grid inside the clinic's
 * working hours, clear of the doctor's and the room's live bookings (taken
 * cells carry the patient's initials for staff), plus the next three free
 * starts after `after`. 422 for a bad date or duration, 404 for a doctor of
 * another tenant.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    return ok(await findFreeSlots(ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return handleApiError(err);
  }
}

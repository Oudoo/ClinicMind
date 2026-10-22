import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { listStaff, zBookableRole } from "@/modules/appointments/service";

export const dynamic = "force-dynamic";

/**
 * `GET /api/staff?role=DOCTOR` → `{ staff: [{ id, fullName, role }] }`.
 *
 * Active, non-deleted staff of the acting tenant in a bookable role (DOCTOR,
 * NURSE, CLINIC_OWNER). Available to every authenticated member so doctor
 * pickers work for reception and assistants, who cannot manage users.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    const role = zBookableRole.optional().parse(new URL(req.url).searchParams.get("role") ?? undefined);
    return ok({ staff: await listStaff(ctx.tenantId, role) });
  } catch (err) {
    return handleApiError(err);
  }
}

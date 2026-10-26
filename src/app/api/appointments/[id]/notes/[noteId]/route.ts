import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { deleteAppointmentNote } from "@/modules/appointments/notes";
import { appointmentErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `DELETE /api/appointments/[id]/notes/[noteId]` → `{ ok, id, deletedAt }`.
 * Soft-deletes the note (the "drop"); only its author or a user manager may.
 * 404 for a note, or an appointment, of another tenant; 403 for anyone else.
 */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; noteId: string }> }) {
  try {
    const { id, noteId } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:write");
    const result = await deleteAppointmentNote(
      ctx.tenantId,
      id,
      noteId,
      { id: ctx.userId, email: ctx.email, ip: clientIp(req) },
      { canManage: can(ctx.role, "users:manage") },
    );
    return ok({ ok: true, ...result });
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createAppointmentNote, listAppointmentNotes } from "@/modules/appointments/notes";
import { appointmentErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/appointments/[id]/notes` → `{ notes }` (live notes, oldest first); a foreign tenant's id is a 404. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    return ok({ notes: await listAppointmentNotes(ctx.tenantId, id) });
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/appointments/[id]/notes` body `{ body (≤ 5000), kind?: DICTATION|TEXT,
 * language?: auto|ar|en, durationSeconds? }` → 201 `{ note }`. Writes an AUDIO
 * event on the patient timeline and an audit entry.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:write");
    const note = await createAppointmentNote(ctx.tenantId, id, await req.json(), {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok({ note }, { status: 201 });
  } catch (err) {
    return appointmentErrorResponse(err) ?? handleApiError(err);
  }
}

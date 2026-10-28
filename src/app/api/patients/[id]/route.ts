import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { archivePatient, getPatient, updatePatient } from "@/modules/patients/service";
import { patientErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * The full patient record (profile, medical history, medications, timeline,
 * visits, consultations, upcoming appointments). A patient of another tenant
 * is a 404, exactly like a missing one.
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");

    const patient = await getPatient(ctx.tenantId, id);
    if (!patient) return notFound("patient");
    return ok({ patient });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * Partial profile update. Blank or `null` clears an optional field. 409
 * `duplicate_phone` / `duplicate_national_id` when a changed number or id
 * belongs to another active patient, unless `confirmDuplicate: true`.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const patient = await updatePatient(ctx.tenantId, id, body, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!patient) return notFound("patient");
    return ok({ patient });
  } catch (err) {
    return patientErrorResponse(err) ?? handleApiError(err);
  }
}

/** Archive (soft delete). The record and its history are kept; see /restore. */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const patient = await archivePatient(ctx.tenantId, id, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!patient) return notFound("patient");
    return ok({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}

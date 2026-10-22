import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { updateMedicalHistory } from "@/modules/patients/service";

export const dynamic = "force-dynamic";

/**
 * Replace the medical history lists sent in the body (chronicConditions,
 * allergies, surgeries, diagnoses). Lists are trimmed and de-duplicated; a new
 * diagnosis also lands on the patient's timeline. Responds `{ medicalHistory }`.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const medicalHistory = await updateMedicalHistory(ctx.tenantId, id, body, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!medicalHistory) return notFound("patient");
    return ok({ medicalHistory });
  } catch (err) {
    return handleApiError(err);
  }
}

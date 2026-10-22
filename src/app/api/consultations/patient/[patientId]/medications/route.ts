import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { ok, unauthorized } from "@/lib/api";
import { handleConsultationError, listActiveMedications } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/**
 * Active medications of a patient, for the "stop existing medication"
 * checklist of the review step. 404 for a patient of another tenant.
 */
export async function GET(req: Request, { params }: { params: Promise<{ patientId: string }> }) {
  try {
    const { patientId } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    return ok({ medications: await listActiveMedications(ctx.tenantId, patientId) });
  } catch (err) {
    return handleConsultationError(err);
  }
}

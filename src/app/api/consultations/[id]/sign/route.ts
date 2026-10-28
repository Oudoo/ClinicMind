import { getActingContext } from "@/lib/auth/session";
import { assertCan, assertCanSignClinical, canSignClinical } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { handleConsultationError, signConsultation, SignInput } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/**
 * Sign a reviewed consultation. ONLY clinicians (consultations:sign) may do this.
 *
 * Body: `{ summary?, extraction?, appointmentId?, stopMedicationIds? }` — the
 * clinician's reviewed version of the AI draft. In one transaction the
 * immutable Visit is created (linked to the appointment when given, which is
 * then completed), only new diagnoses are appended to the medical history,
 * medications are reconciled against the patient's active list and listed
 * ones are stopped, and timeline events are emitted. The audit row keeps the
 * AI draft next to what was signed.
 *
 * 403 without the permission · 404 for another tenant's consultation,
 * appointment or medication · 409 unless the consultation is PENDING_REVIEW.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanSignClinical(ctx);

    const input = SignInput.parse(await req.json());
    const result = await signConsultation(ctx.tenantId, id, input, {
      userId: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok(result);
  } catch (err) {
    return handleConsultationError(err);
  }
}

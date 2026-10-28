import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { checkConsultationSafety, handleConsultationError, SafetyCheckInput } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/**
 * Prescribing safety checks for a consultation, against the patient's record
 * (sex and age, documented allergies, chronic conditions and past diagnoses,
 * active medications): allergy and cross-reactivity, duplicate therapy,
 * interactions, pregnancy and sex, age, daily dose and conditions.
 *
 * GET checks the stored draft. POST checks the review panel's current list:
 * `{ medications?, diagnoses?, stopMedicationIds? }` (stopped medications are
 * left out of the comparison). Read-only — signing recomputes the same
 * findings on the server. → `{ findings, context }`.
 *
 * consultations:read · 404 for another tenant's consultation · 422 invalid body.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");
    return ok(await checkConsultationSafety(ctx.tenantId, id, SafetyCheckInput.parse({})));
  } catch (err) {
    return handleConsultationError(err);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");
    const input = SafetyCheckInput.parse(await req.json());
    return ok(await checkConsultationSafety(ctx.tenantId, id, input));
  } catch (err) {
    return handleConsultationError(err);
  }
}

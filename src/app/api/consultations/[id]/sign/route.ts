import { getActingContext } from "@/lib/auth/session";
import { assertCan, assertCanSignClinical, canSignClinical } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { handleConsultationError, signConsultation, SignInput } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/**
 * Sign a reviewed consultation. ONLY clinicians (consultations:sign) may do this.
 *
 * Body: `{ summary?, extraction?, appointmentId?, stopMedicationIds?,
 * overrides?: [{ rule, medication, reason (≥ 10 chars) }], acknowledgedWarnings?,
 * summaryConfirmed? }` — the clinician's reviewed version of the AI draft.
 *
 * Before anything is written the server recomputes the prescribing-safety
 * findings for the medications being signed (never trusting the browser's):
 * a "stop" without an override reason → 409 `{ error: "safety_stop",
 * findings, missing }`; "warn" findings without `acknowledgedWarnings` → 409
 * `{ error: "safety_warning", findings }`. A summary that still mentions a
 * diagnosis or medication removed from the draft → 409 `{ error:
 * "summary_mismatch", mentions }` unless `summaryConfirmed`.
 *
 * Then, in one transaction, the immutable Visit is created (linked to the
 * appointment when given, which is then completed), only new diagnoses are
 * appended to the medical history, medications are reconciled against the
 * patient's active list by generic ("Minoxidil 5%" updates "Minoxidil 5%
 * solution") and listed ones are stopped, timeline events are emitted and
 * every overridden stop and acknowledged warning is stored as a
 * SafetyOverride (audited as consultation.safety_override). The audit row
 * keeps the AI draft next to what was signed.
 *
 * 403 unless a clinician · 404 for another tenant's consultation, appointment
 * or medication · 409 unless PENDING_REVIEW, or as above · 422 invalid body.
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

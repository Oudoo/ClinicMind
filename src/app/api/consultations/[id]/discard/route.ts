import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { ok, unauthorized } from "@/lib/api";
import { discardConsultation, handleConsultationError } from "@/modules/consultations/service";

export const dynamic = "force-dynamic";

/**
 * Discard a draft that is PENDING_REVIEW. Nothing of it reaches the patient's
 * record. Clinicians may discard any draft of their tenant; other staff only
 * the drafts they captured themselves.
 *
 * 404 for another tenant's consultation · 409 unless PENDING_REVIEW.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "consultations:read");

    const result = await discardConsultation(
      ctx.tenantId,
      id,
      { userId: ctx.userId, email: ctx.email, ip: clientIp(req) },
      { canSign: can(ctx.role, "consultations:sign") },
    );
    return ok(result);
  } catch (err) {
    return handleConsultationError(err);
  }
}

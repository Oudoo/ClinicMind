import { getActingContext } from "@/lib/auth/session";
import { assertCanAskEvidence } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { logExternalQuestion } from "@/modules/evidence/service";
import { actorOf, evidenceErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/evidence/external` `{ question, patientId? }` → `{ sentQuestion }`: logs a question
 * the doctor took to OpenEvidence, as it left the clinic (the patient's name, numbers and
 * e-mail taken out). Clinicians only, as the panel.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanAskEvidence(ctx);
    return ok(await logExternalQuestion(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req)));
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCanAskEvidence } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { askEvidence } from "@/modules/evidence/service";
import { actorOf, evidenceErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * `POST /api/evidence/ask` `{ question, patientId? }` → the answer from the clinic's
 * approved library: `{ sentQuestion, grounded, noGoodSource, statements: [{ text, cites }],
 * citations: [{ n, title, publisher, year, heading, passage, … }], context, mode, provider,
 * model, runId }`. Clinicians only (a doctor or the owner with the clinician mark).
 * The patient's facts go without their name, phone, ID or date of birth, and those are
 * taken out of the question (`sentQuestion` is what was searched and sent). Logged as
 * an AI run of kind "evidence".
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanAskEvidence(ctx);
    return ok(await askEvidence(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req)));
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

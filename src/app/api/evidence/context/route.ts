import { getActingContext } from "@/lib/auth/session";
import { assertCanAskEvidence } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { questionContext } from "@/modules/evidence/service";
import { evidenceErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/evidence/context?patientId=` → `{ context }`: what goes with a question
 * about this patient (age, sex, pregnancy, allergies, medications, conditions; never
 * a name, phone, ID or date of birth), for the doctor to see before asking.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanAskEvidence(ctx);
    const patientId = new URL(req.url).searchParams.get("patientId")?.trim();
    if (!patientId) return ok({ context: [] });
    return ok({ context: await questionContext(ctx.tenantId, patientId) });
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

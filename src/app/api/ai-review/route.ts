import { getActingContext } from "@/lib/auth/session";
import { assertCanApproveEvidence } from "@/lib/auth/rbac";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { monthlyReview } from "@/modules/ai-log/review";

export const dynamic = "force-dynamic";

/**
 * `GET /api/ai-review?month=YYYY-MM` → the month's review of the clinic's AI (this month by
 * default): questions, how they were answered and rated, what nothing answered, the sources
 * cited, OpenEvidence hand-offs and safety overrides. The owner, with the clinician mark.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCanApproveEvidence(ctx);
    return ok(await monthlyReview(ctx.tenantId, new URL(req.url).searchParams.get("month") ?? undefined));
  } catch (err) {
    return handleApiError(err);
  }
}

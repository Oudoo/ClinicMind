import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCanUseAssistant } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin, userAgent } from "@/lib/auth/request";
import { resolveTenantAi } from "@/lib/ai/tenant-config";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { askAssistant, AssistantProviderError } from "@/modules/assistant/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  query: z.string().trim().min(1).max(2000),
  /** Optional patient context: restricts the answer to that patient's records. */
  patientId: z.string().trim().min(1).max(64).optional(),
  /** Page of a cohort answer (200 patients per page). */
  page: z.number().int().min(1).max(1000).optional(),
});

/**
 * Doctor AI assistant — tenant-scoped, permission `ai:assistant` and the clinician mark.
 *
 * Body: `{ query, patientId?, page? }`.
 *
 * Response: `{ answer, citations, confidence, grounded, provider, model,
 * latencyMs, mode, criteria, cohort?, clarify?, scope?, notices, aiRunId }`.
 * `mode` is "cohort" (a list question answered from every record: `cohort`
 * holds the total, the page and every matching patient), "patient" (a yes/no
 * check against one patient's chart), "clarify" (the question named an
 * ambiguous patient or a criterion that could not be used — nothing broader is
 * answered) or "rag" (retrieval-grounded generation with citations).
 *
 * Every question is recorded as an AiRun ("assistant_cohort" or
 * "assistant_chat") and an "assistant.query" audit row with the criteria. A
 * provider outage answers 502 `ai_provider_error` (recorded as a FAILED run).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    // Clinicians only, checked on every request (the AI lead and the platform admin are not).
    assertCanUseAssistant(ctx);

    const { query, patientId, page } = Body.parse(await req.json());
    // A client-supplied patient id must belong to the acting tenant (SEC-4);
    // a foreign id is indistinguishable from a missing one (404).
    if (patientId) await requireTenantPatient(ctx.tenantId, patientId);

    try {
      const answer = await askAssistant(
        { tenantId: ctx.tenantId, userId: ctx.userId, email: ctx.email, ip: clientIp(req), device: userAgent(req) },
        { query, patientId: patientId ?? null, page },
        { tenantAi: await resolveTenantAi(ctx.tenantId) },
      );
      return ok(answer);
    } catch (err) {
      if (err instanceof AssistantProviderError) {
        return ok(
          { error: "ai_provider_error", provider: err.provider, message: "The AI provider did not answer. Try again in a moment." },
          { status: 502 },
        );
      }
      throw err;
    }
  } catch (err) {
    return handleApiError(err);
  }
}

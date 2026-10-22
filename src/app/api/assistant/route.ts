import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { answerWithRag } from "@/lib/ai/rag";
import { AiProviderError } from "@/lib/ai/provider";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { db } from "@/lib/db";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({
  query: z.string().trim().min(1).max(2000),
  /** Optional patient context: restricts retrieval to that patient's records. */
  patientId: z.string().trim().min(1).max(64).optional(),
});

/**
 * Doctor AI chat — RAG-grounded, tenant-scoped, audited as an AiRun.
 *
 * Response: `{ answer, citations, confidence, grounded, provider, model, latencyMs }`.
 * A provider outage answers 502 `ai_provider_error` (and is recorded as a
 * FAILED run) rather than a generic 500.
 */
export async function POST(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "ai:assistant");

    const { query, patientId } = Body.parse(await req.json());
    // A client-supplied patient id must belong to the acting tenant (SEC-4);
    // a foreign id is indistinguishable from a missing one (404).
    if (patientId) await requireTenantPatient(ctx.tenantId, patientId);

    const started = Date.now();
    let result;
    try {
      result = await answerWithRag(ctx.tenantId, query, { patientId });
    } catch (err) {
      if (err instanceof AiProviderError) {
        await db.aiRun
          .create({
            data: {
              tenantId: ctx.tenantId,
              authorId: ctx.userId,
              kind: "assistant_chat",
              provider: err.provider,
              model: "",
              rawPrompt: query,
              status: "FAILED",
              error: err.message.slice(0, 500),
              latencyMs: Date.now() - started,
            },
          })
          .catch(() => undefined);
        return ok(
          { error: "ai_provider_error", provider: err.provider, message: "The AI provider did not answer. Try again in a moment." },
          { status: 502 },
        );
      }
      throw err;
    }

    // Immutable record of the AI invocation. The retrieved context is stored
    // as compact references; the chunk text itself lives in the knowledge store.
    await db.aiRun
      .create({
        data: {
          tenantId: ctx.tenantId,
          authorId: ctx.userId,
          kind: "assistant_chat",
          provider: result.provider,
          model: result.model,
          rawPrompt: query,
          retrievedContext: result.chunks.map((c) => ({ id: c.id, source: c.source, refId: c.refId, score: c.score })),
          generatedOutput: result.answer,
          citations: result.citations.map((c) => ({
            index: c.index,
            source: c.source,
            refId: c.refId,
            patientId: c.patientId,
            title: c.title,
          })),
          confidenceScore: result.confidence,
          status: "SUCCEEDED",
          latencyMs: result.latencyMs,
        },
      })
      .catch(() => undefined);

    return ok({
      answer: result.answer,
      citations: result.citations,
      confidence: result.confidence,
      grounded: result.grounded,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

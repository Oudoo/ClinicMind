import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { answerWithRag } from "@/lib/ai/rag";
import { db } from "@/lib/db";
import { handleApiError, ok, unauthorized } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const Body = z.object({ query: z.string().min(1).max(2000) });

/** Doctor AI chat — RAG-grounded, tenant-scoped, audited as an AiRun. */
export async function POST(req: Request) {
  try {
    const ctx = await getActingContext();
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "ai:assistant");

    const { query } = Body.parse(await req.json());
    const result = await answerWithRag(ctx.tenantId, query);

    // Immutable record of the AI invocation.
    await db.aiRun
      .create({
        data: {
          tenantId: ctx.tenantId,
          authorId: ctx.userId,
          kind: "assistant_chat",
          provider: result.provider,
          model: result.model,
          rawPrompt: query,
          retrievedContext: result.chunks as never,
          generatedOutput: result.answer,
          citations: result.citations as never,
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
      provider: result.provider,
      model: result.model,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

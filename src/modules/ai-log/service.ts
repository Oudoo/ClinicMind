import { z } from "zod";
import { db } from "@/lib/db";
import { TenantScopeError } from "@/lib/tenant-scope";
import { zOptionalText } from "@/lib/validation";
import { FEEDBACK_COMMENT_MAX, QUESTION_KINDS } from "./constants";

/**
 * Doctors rate the answers they asked for (Phase 4, log and review). A rating
 * is a new row, never an edit (the database keeps every one): the latest
 * counts. Only the doctor who asked rates an answer.
 */

export class AiLogError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AiLogError";
  }
}

export const FeedbackInput = z.object({
  helpful: z.boolean(),
  comment: zOptionalText(FEEDBACK_COMMENT_MAX),
});

export interface FeedbackDTO {
  id: string;
  helpful: boolean;
  comment: string | null;
  createdAt: string;
}

export async function rateRun(tenantId: string, runId: string, raw: unknown, actor: { id: string | null }): Promise<FeedbackDTO> {
  const input = FeedbackInput.parse(raw);
  const run = await db.aiRun.findFirst({ where: { id: runId, tenantId }, select: { id: true, authorId: true, kind: true } });
  if (!run) throw new TenantScopeError("ai_run", runId);
  if (!(QUESTION_KINDS as readonly string[]).includes(run.kind)) throw new AiLogError(409, "not_a_question", "Only answers to questions are rated.");
  if (!actor.id || run.authorId !== actor.id) throw new AiLogError(403, "not_yours", "Only the doctor who asked rates the answer.");
  const row = await db.aiFeedback.create({
    data: { tenantId, runId, userId: actor.id, helpful: input.helpful, comment: input.comment ?? null },
    select: { id: true, helpful: true, comment: true, createdAt: true },
  });
  return { ...row, createdAt: row.createdAt.toISOString() };
}

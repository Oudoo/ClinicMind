import { NextResponse } from "next/server";
import { getActingContext } from "@/lib/auth/session";
import { canAskEvidence, canUseAssistant, RbacError } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { AiLogError, rateRun } from "@/modules/ai-log/service";

export const dynamic = "force-dynamic";

/**
 * `POST /api/ai-runs/[id]/feedback` `{ helpful: boolean, comment? }` → 201 `{ feedback }`:
 * the doctor who asked rates the answer (a new rating replaces the last one in the
 * review; every one is kept). Clinicians only.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    if (!canAskEvidence(ctx) && !canUseAssistant(ctx)) throw new RbacError("Only clinicians rate the AI's answers");
    return ok({ feedback: await rateRun(ctx.tenantId, id, await req.json().catch(() => null), { id: ctx.userId }) }, { status: 201 });
  } catch (err) {
    if (err instanceof AiLogError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
    return handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan, assertCanApproveEvidence } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { approveSource, getSource, retireSource, updateSource } from "@/modules/evidence/service";
import { actorOf, evidenceErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/evidence/sources/[id]` → `{ source }` with its text and the passages the panel cites. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "evidence:read");
    const source = await getSource(ctx.tenantId, id);
    return source ? ok({ source }) : notFound("evidence_source");
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `PATCH /api/evidence/sources/[id]`
 * - `{ action: "approve" }`: the panel may quote it from now on (the owner, with the clinician mark).
 * - `{ action: "retire" }`: it answers nothing more; answers that cited it still show it (the same).
 * - any of the source's fields: an approved source whose text, title, publisher or year changes waits for approval again.
 * → `{ source }`.
 */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    const actor = actorOf(ctx, req);
    if (body.action === "approve" || body.action === "retire") {
      assertCanApproveEvidence(ctx);
      return ok({ source: body.action === "approve" ? await approveSource(ctx.tenantId, id, actor) : await retireSource(ctx.tenantId, id, actor) });
    }
    assertCan(ctx.role, "evidence:write");
    const { action: _action, ...fields } = body;
    return ok({ source: await updateSource(ctx.tenantId, id, fields, actor) });
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

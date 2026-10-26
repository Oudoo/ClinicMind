import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { discardDraftProtocol, getProtocol, updateDraftProtocol } from "@/modules/concierge/service";
import { conciergeContext, jsonBody, type IdParams } from "../../_lib/context";
import { conciergeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/concierge/protocols/[id]` → `{ protocol }` (with its treatment). */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    const protocol = await getProtocol(c.ctx.tenantId, id);
    if (!protocol) return notFound("protocol");
    return ok({ protocol });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `PATCH /api/concierge/protocols/[id]` with `{ name?, steps?, notes? }` —
 * edit a DRAFT (steps are validated: offsets, kinds, bilingual bodies,
 * questions with expected ranges and the high-risk flag). → `{ protocol }`;
 * 409 `draft_only` for an active or retired version; 422 with the step paths.
 */
export async function PATCH(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    return ok({ protocol: await updateDraftProtocol(c.ctx.tenantId, id, await jsonBody(req), c.actor) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `DELETE /api/concierge/protocols/[id]` — discard a DRAFT. → `{ discarded: { id, version } }`; 409 `draft_only` for an active or retired version. */
export async function DELETE(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    return ok({ discarded: await discardDraftProtocol(c.ctx.tenantId, id, c.actor) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { createDraftProtocol, listTreatmentProtocols } from "@/modules/concierge/service";
import { conciergeContext, jsonBody } from "../_lib/context";
import { conciergeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/concierge/protocols` → `{ treatments: [{ treatment, active, drafts, retired }] }`. */
export async function GET(req: Request) {
  try {
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    return ok({ treatments: await listTreatmentProtocols(c.ctx.tenantId) });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/concierge/protocols` with `{ treatmentId, name? }` — "New
 * version": copies the active protocol (or the default) of the treatment into
 * a DRAFT one version up. → 201 `{ protocol }`; 409 `draft_exists` (with
 * `protocolId`) when the treatment already has a draft; 404 for a foreign
 * treatment.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    return ok({ protocol: await createDraftProtocol(c.ctx.tenantId, await jsonBody(req), c.actor) }, { status: 201 });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

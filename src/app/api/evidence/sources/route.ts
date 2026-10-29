import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createSource, listSources } from "@/modules/evidence/service";
import { actorOf, evidenceErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/evidence/sources` → `{ sources }`: the clinic's library, approved first, then waiting for approval, then retired. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "evidence:read");
    return ok({ sources: await listSources(ctx.tenantId) });
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/evidence/sources` `{ title, kind: GUIDELINE|DRUG_INFO|PROTOCOL, publisher?, year?, url?, language?: en|ar, body }`
 * → 201 `{ source }`, waiting for the owner's approval before the panel may quote it.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "evidence:write");
    const source = await createSource(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ source }, { status: 201 });
  } catch (err) {
    return evidenceErrorResponse(err) ?? handleApiError(err);
  }
}

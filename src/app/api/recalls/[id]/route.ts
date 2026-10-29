import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { getRecall } from "@/modules/recalls/service";
import { recallErrorResponse, type Params } from "../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/recalls/[id]` → `{ recall }` with its whole log (every call, message, change and note). */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:read");
    const recall = await getRecall(ctx.tenantId, id);
    return recall ? ok({ recall }) : notFound("recall");
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

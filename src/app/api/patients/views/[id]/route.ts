import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { deleteSavedView, updateSavedView } from "@/modules/patients/views";
import { noUser, savedViewErrorResponse } from "../../_lib/views";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `PATCH /api/patients/views/[id]` `{ name?, params? }` → `{ view }`; another user's view is a 404. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    if (!ctx.userId) return noUser();

    const body: unknown = await req.json().catch(() => null);
    const view = await updateSavedView(ctx.tenantId, ctx.userId, id, body, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!view) return notFound("saved_view");
    return ok({ view });
  } catch (err) {
    return savedViewErrorResponse(err) ?? handleApiError(err);
  }
}

/** `DELETE /api/patients/views/[id]` → `{ ok: true }`. */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    if (!ctx.userId) return noUser();

    const view = await deleteSavedView(ctx.tenantId, ctx.userId, id, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    if (!view) return notFound("saved_view");
    return ok({ ok: true });
  } catch (err) {
    return handleApiError(err);
  }
}

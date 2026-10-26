import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createSavedView, listSavedViews } from "@/modules/patients/views";
import { noUser, savedViewErrorResponse } from "../_lib/views";

export const dynamic = "force-dynamic";

/** `GET /api/patients/views` → `{ views: [{ id, name, params, createdAt, updatedAt }] }` (the caller's own). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    if (!ctx.userId) return noUser();
    return ok({ views: await listSavedViews(ctx.tenantId, ctx.userId) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `POST /api/patients/views` `{ name, params }` → 201 `{ view }`. */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:read");
    if (!ctx.userId) return noUser();

    const body: unknown = await req.json().catch(() => null);
    const view = await createSavedView(ctx.tenantId, ctx.userId, body, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok({ view }, { status: 201 });
  } catch (err) {
    return savedViewErrorResponse(err) ?? handleApiError(err);
  }
}

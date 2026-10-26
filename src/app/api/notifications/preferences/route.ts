import { getActingContext } from "@/lib/auth/session";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { EMAIL_DEFAULT_ON, getPreferences, updatePreferences } from "@/modules/notifications/service";
import { NO_STORE } from "../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/notifications/preferences` → `{ preferences, emailDefaultOn }` for the caller. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx?.userId) return unauthorized();
    return ok({ preferences: await getPreferences(ctx.tenantId, ctx.userId), emailDefaultOn: EMAIL_DEFAULT_ON }, NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `PATCH /api/notifications/preferences` with a partial `PreferencesInput`
 * (`inApp`, `email` maps by kind, `browser`, `digestHour` 0–23 or null) →
 * `{ preferences }` after the merge. 422 on anything else.
 */
export async function PATCH(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx?.userId) return unauthorized();
    const preferences = await updatePreferences(ctx.tenantId, ctx.userId, await req.json().catch(() => ({})), {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok({ preferences }, NO_STORE);
  } catch (err) {
    return handleApiError(err);
  }
}

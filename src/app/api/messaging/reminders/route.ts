import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { readReminderSettings, saveReminderSettings } from "@/modules/messaging/reminder-settings";

export const dynamic = "force-dynamic";

/** `GET /api/messaging/reminders` → `{ settings }`: quiet hours, appointment reminders, recall messages, tomorrow's call list. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "appointments:read");
    return ok({ settings: await readReminderSettings(ctx.tenantId) });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `PUT /api/messaging/reminders` `{ quietStart, quietEnd, appointmentReminders, recallMessages, confirmCallsFrom }`
 * (times as HH:mm on the clinic clock; the owner only) → `{ settings }`. Audited.
 */
export async function PUT(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const settings = await saveReminderSettings(ctx.tenantId, await req.json().catch(() => null), { id: ctx.userId, email: ctx.email, ip: clientIp(req) });
    return ok({ settings });
  } catch (err) {
    return handleApiError(err);
  }
}

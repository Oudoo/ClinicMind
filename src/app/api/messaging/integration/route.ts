import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { getIntegrationStatus, updateIntegration } from "@/modules/messaging/integrations";
import { actorOf } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/messaging/integration` → `{ integration }`: provider, status,
 * config (never the secret), env flags, inbound URL. Staff without
 * tenant:manage see the outbound URL shortened to its host.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:read");
    return ok({ integration: await getIntegrationStatus(ctx.tenantId, ctx.tenantSlug, { redact: !can(ctx.role, "tenant:manage") }) });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `PATCH /api/messaging/integration` { provider: manual|whatsapp_cloud|inbox_webhook, phoneNumberId?, outboundUrl?, enabled? }
 * → `{ integration }` (tenant:manage).
 */
export async function PATCH(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const integration = await updateIntegration(ctx.tenantId, ctx.tenantSlug, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ integration });
  } catch (err) {
    return handleApiError(err);
  }
}

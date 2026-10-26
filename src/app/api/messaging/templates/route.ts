import { getActingContext } from "@/lib/auth/session";
import { assertCan, can } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createTemplate, listTemplates } from "@/modules/messaging/templates";
import { actorOf, messagingErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/** `GET /api/messaging/templates[?all=1]` → `{ templates }` (conversations:read; `all` includes inactive ones for owners). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "conversations:read");
    const all = new URL(req.url).searchParams.get("all") === "1" && can(ctx.role, "tenant:manage");
    return ok({ templates: await listTemplates(ctx.tenantId, { includeInactive: all }) });
  } catch (err) {
    return handleApiError(err);
  }
}

/** `POST /api/messaging/templates` { key, name, language, body, category?, channel?, active? } → 201 `{ template }` (tenant:manage). */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "tenant:manage");
    const template = await createTemplate(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ template }, { status: 201 });
  } catch (err) {
    return messagingErrorResponse(err) ?? handleApiError(err);
  }
}

import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { LeadListQuery, createLead, listLeads } from "@/modules/crm/service";
import { actorOf, crmErrorResponse } from "./_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/leads?q&stage&source&ownerId&interest&campaignId&from&to&sort&page&pageSize`
 * → `{ leads, total, page, pageSize }` (leads:read).
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:read");
    const filter = LeadListQuery.parse(Object.fromEntries(new URL(req.url).searchParams));
    return ok(await listLeads(ctx.tenantId, filter));
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `POST /api/leads` { fullName, phone?, whatsapp?, email?, source?, campaignId?,
 * interests?, ownerId?, notes?, conversationId?, stage? } → 201 `{ lead }` (leads:write).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "leads:write");
    const lead = await createLead(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ lead }, { status: 201 });
  } catch (err) {
    return crmErrorResponse(err) ?? handleApiError(err);
  }
}

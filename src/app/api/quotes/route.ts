import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { createDraft, listQuotes } from "@/modules/quotes/service";
import { financeErrorResponse } from "../procedures/_lib/errors";
import { actorOf } from "./_lib";

export const dynamic = "force-dynamic";

/** `GET /api/quotes?patientId&state&q&page&pageSize` (`quotes:read`) → `{ quotes, total, page, pageSize }`, newest first; `state` is DRAFT, SENT (open), EXPIRED, ACCEPTED, DECLINED or WITHDRAWN. */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:read");
    return ok(await listQuotes(ctx.tenantId, Object.fromEntries(new URL(req.url).searchParams)));
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/**
 * `POST /api/quotes` (`quotes:write`) `{ patientId, clinicId?, doctorId?, language?, title?, note?,
 * validUntil? (YYYY-MM-DD), phases: [{ title, items: [{ priceItemId, quantity?, site?, discount?,
 * discountReason?, discountNote? }] }] }` → 201 `{ quote }`: a draft priced from today's list for the
 * branch, each discount within the role's limit (403 `discount_limit` above it).
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:write");
    const quote = await createDraft(ctx.tenantId, await req.json().catch(() => null), actorOf(ctx, req));
    return ok({ quote }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

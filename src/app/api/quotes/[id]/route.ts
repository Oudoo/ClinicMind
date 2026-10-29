import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { discardDraft, getQuote, updateDraft } from "@/modules/quotes/service";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { actorOf } from "../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `GET /api/quotes/[id]` (`quotes:read`) → `{ quote }` with its phases, items, answer and the procedures accepted items became. */
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:read");
    return ok({ quote: await getQuote(ctx.tenantId, id) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `PATCH /api/quotes/[id]` (`quotes:write`) `{ clinicId?, doctorId?, language?, title?, note?, validUntil?, phases? }` — change a draft; the phases replace its items, priced for today. A quote given: 409. */
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:write");
    return ok({ quote: await updateDraft(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req)) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `DELETE /api/quotes/[id]` (`quotes:write`) — discard a draft. A quote given: 409 (withdraw it). */
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:write");
    await discardDraft(ctx.tenantId, id, actorOf(ctx, req));
    return ok({ discarded: true });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

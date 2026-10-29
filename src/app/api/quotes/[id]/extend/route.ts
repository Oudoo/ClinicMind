import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { extendQuote } from "@/modules/quotes/service";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { actorOf } from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** `POST /api/quotes/[id]/extend` (`quotes:write`) `{ validUntil }` (YYYY-MM-DD, today or later) — a new last valid day for a quote given and not answered; an expired one opens again. → `{ quote }`. */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "quotes:write");
    return ok({ quote: await extendQuote(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req)) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

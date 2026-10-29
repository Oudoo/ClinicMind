import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { actOnRecall } from "@/modules/recalls/service";
import { actorOf, recallErrorResponse, type Params } from "../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/recalls/[id]/actions` — work the recall, logged and audited:
 *  - `{ action: "call", outcome, note?, callBackOn?, reason? }` (no_answer, call_back with the day,
 *    thinking, will_book, wrong_number → unreachable, declined with the reason);
 *  - `{ action: "message" }`: the WhatsApp template, now (422 `no_phone`);
 *  - `{ action: "snooze", until, note? }`, `{ action: "decline", reason, note? }`,
 *    `{ action: "unreachable", note? }`, `{ action: "reopen", note? }`, `{ action: "note", note }`.
 * → `{ recall, message? }`; 409 `closed`, `booked`, `state_changed`.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "recalls:write");
    return ok(await actOnRecall(ctx.tenantId, id, await req.json().catch(() => null), actorOf(ctx, req)));
  } catch (err) {
    return recallErrorResponse(err) ?? handleApiError(err);
  }
}

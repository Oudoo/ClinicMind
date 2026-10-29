import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { addLabFiles } from "@/modules/lab/orders";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { boundedJson, expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `POST /api/lab-orders/[id]/files` (`lab:write`, clinicians) `{ files: [{ name?, type?, data }] }` — the lab's report, a photo or a PDF. → 201 `{ order }`. */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "lab:write");
    if (!c) return unauthorized();
    const read = await boundedJson(req);
    if ("response" in read) return read.response;
    const files = read.body && typeof read.body === "object" ? (read.body as { files?: unknown }).files : undefined;
    return ok({ order: await addLabFiles(c.ctx.tenantId, id, files, c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { addExpenseFiles } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { boundedJson, expenseContext, type IdParams } from "../../_lib/context";

export const dynamic = "force-dynamic";

/**
 * `POST /api/expenses/[id]/files` (`expenses:write`) `{ files: [{ name?, type?, data }] }` — a photo or a PDF of the bill or
 * the receipt (typed by its bytes; JPEG, PNG, WebP, HEIC or PDF, 5 MB each; 413 past one request's size). → 201 `{ expense }`.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "expenses:write");
    if (!c) return unauthorized();
    const read = await boundedJson(req);
    if ("response" in read) return read.response;
    const files = read.body && typeof read.body === "object" ? (read.body as { files?: unknown }).files : undefined;
    return ok({ expense: await addExpenseFiles(c.ctx.tenantId, id, files, c.actor) }, { status: 201 });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

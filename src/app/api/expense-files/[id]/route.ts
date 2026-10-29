import { isSameOrigin, crossOriginRejected } from "@/lib/auth/request";
import { handleApiError, notFound, ok, unauthorized } from "@/lib/api";
import { expenseFileFor, removeExpenseFile } from "@/modules/finance/expenses";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" };

/**
 * `GET /api/expense-files/[id]` (`expenses:read`) — a receipt's photo (inline) or PDF (a download), for whoever may see its
 * expense (salaries: the owner); anything else is a plain 404. Private caching only, sniffing off, and a sandboxing CSP
 * in case a photo is opened on its own.
 */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "expenses:read");
    if (!c) return unauthorized();
    const file = await expenseFileFor(c.ctx.tenantId, id, c.ctx.role);
    if (!file) return notFound("file");
    const pdf = file.mimeType === "application/pdf";
    const filename = `receipt-${id}.${EXTENSIONS[file.mimeType] ?? "bin"}`;
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `${pdf ? "attachment" : "inline"}; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

/** `DELETE /api/expense-files/[id]` (`tenant:manage`) — remove a file attached by mistake. → `{ expense }`. */
export async function DELETE(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await expenseContext(req, "tenant:manage");
    if (!c) return unauthorized();
    return ok({ expense: await removeExpenseFile(c.ctx.tenantId, id, c.actor) });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

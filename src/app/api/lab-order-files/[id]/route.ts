import { handleApiError, notFound, unauthorized } from "@/lib/api";
import { labFileFor } from "@/modules/lab/orders";
import { financeErrorResponse } from "../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../expenses/_lib/context";

export const dynamic = "force-dynamic";

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif", "application/pdf": "pdf" };

/**
 * `GET /api/lab-order-files/[id]` (`lab:read`, clinicians) — a page of a lab's report: a photo inline, a PDF as a
 * download; anything else is a plain 404. Private caching only, sniffing off, a sandboxing CSP.
 */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "lab:read");
    if (!c) return unauthorized();
    const file = await labFileFor(c.ctx.tenantId, id, c.ctx.role);
    if (!file) return notFound("file");
    const pdf = file.mimeType === "application/pdf";
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `${pdf ? "attachment" : "inline"}; filename="lab-report-${id}.${EXTENSIONS[file.mimeType] ?? "bin"}"`,
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

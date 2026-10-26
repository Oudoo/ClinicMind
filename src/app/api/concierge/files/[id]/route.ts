import { handleApiError, notFound, unauthorized } from "@/lib/api";
import { getConciergeFile } from "@/modules/concierge/service";
import { conciergeContext, type IdParams } from "../../_lib/context";
import { conciergeErrorResponse } from "../../_lib/errors";

export const dynamic = "force-dynamic";

const EXTENSIONS: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif" };

/**
 * `GET /api/concierge/files/[id]` — the bytes of a check-in photo (a Document
 * id from `checkIn.photoIds`), for thumbnails on the enrolment page. Only
 * photos a check-in of the acting tenant lists are served; anything else is a
 * plain 404. Private caching only, inline, sniffing off, and a sandboxing CSP
 * in case a file is ever opened on its own.
 */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await conciergeContext(req, "concierge:read");
    if (!c) return unauthorized();
    const file = await getConciergeFile(c.ctx.tenantId, id);
    if (!file) return notFound("file");
    const filename = `check-in-photo-${id}.${EXTENSIONS[file.mimeType] ?? "img"}`;
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
    });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

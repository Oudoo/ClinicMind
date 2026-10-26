import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { clientIp, crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parsePaging } from "@/lib/validation";
import { createIntakeLink, listIntakeLinks } from "@/modules/intake/service";
import { intakeErrorResponse } from "../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `GET /api/intake/links?status=active|all&patientId=&page=&pageSize=` →
 * `{ links, total, page, pageSize }` with `uses`, `submissionCount` and a
 * derived `status` per link. Requires `patients:write`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const params = new URL(req.url).searchParams;
    const { page, pageSize } = parsePaging(params);
    const result = await listIntakeLinks(ctx.tenantId, {
      page,
      pageSize,
      patientId: params.get("patientId")?.trim().slice(0, 64) || undefined,
      status: params.get("status") === "active" ? "active" : "all",
    });
    return ok(result);
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `POST /api/intake/links` `{ kind: OPEN|PATIENT, patientId?, language, label?,
 * expiresInDays?, maxUses? }` → 201 `{ link, url, qrDataUrl, whatsappUrl, message }`.
 * The URL (which carries the token) and the QR are returned exactly once.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "patients:write");

    const body: unknown = await req.json().catch(() => null);
    const issued = await createIntakeLink(ctx.tenantId, body ?? {}, {
      id: ctx.userId,
      email: ctx.email,
      ip: clientIp(req),
    });
    return ok(issued, { status: 201 });
  } catch (err) {
    return intakeErrorResponse(err) ?? handleApiError(err);
  }
}

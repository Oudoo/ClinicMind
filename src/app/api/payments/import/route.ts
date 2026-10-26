import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { previewImport } from "@/modules/finance/imports";

export const dynamic = "force-dynamic";

/**
 * `POST /api/payments/import` `{ csv }` — preview a POS export: each row with
 * the matched patient (exact phone, Arabic digits normalised) and its problems.
 * Nothing is written. → `{ rows, summary, error }`.
 */
export async function POST(req: Request) {
  try {
    if (!isSameOrigin(req)) return crossOriginRejected();
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "payments:write");
    return ok(await previewImport(ctx.tenantId, await req.json().catch(() => null)));
  } catch (err) {
    return handleApiError(err);
  }
}

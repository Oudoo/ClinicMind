import { getActingContext } from "@/lib/auth/session";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { parsePaging } from "@/lib/validation";
import { listSafetyOverrides, OverrideListQuery, overrideScope } from "@/modules/consultations/safety/overrides";

export const dynamic = "force-dynamic";

/**
 * `GET /api/safety-overrides?doctorId=&severity=stop|warn&period=7d|28d|month|90d|custom&from=&to=&page=&pageSize=`
 *
 * Prescribing-safety overrides (stops signed through with a reason,
 * acknowledged warnings), newest first. The clinic owner sees everyone's; a
 * doctor sees only their own (doctorId is ignored); other roles get 403.
 * → `{ overrides, total, page, pageSize, scope, counts, period }`.
 */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    const scope = overrideScope(ctx);
    const params = new URL(req.url).searchParams;
    const query = OverrideListQuery.parse(Object.fromEntries(params));
    const { page, pageSize } = parsePaging(params, { pageSize: 25, maxPageSize: 100 });
    const r = await listSafetyOverrides(ctx.tenantId, scope, query, { page, pageSize });
    return ok({
      overrides: r.overrides,
      total: r.total,
      page: r.page,
      pageSize: r.pageSize,
      scope: r.scope,
      counts: r.counts,
      period: { preset: r.period.preset, from: r.period.fromKey, to: r.period.toKey },
    });
  } catch (err) {
    return handleApiError(err);
  }
}

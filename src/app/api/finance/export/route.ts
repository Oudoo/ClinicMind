import { z } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/rbac";
import { handleApiError, unauthorized } from "@/lib/api";
import { getTenantTimezone } from "@/modules/appointments/service";
import { exportFinanceCsv } from "@/modules/finance/service";
import { csvResponse } from "@/modules/reporting/csv";
import { periodFromSearchParams } from "@/modules/reporting/query";

export const dynamic = "force-dynamic";

const Query = z.object({ kind: z.enum(["payments", "procedures"]) });

/** `GET /api/finance/export?kind=payments|procedures&from=YYYY-MM-DD&to=YYYY-MM-DD` → CSV (`finance:read`). */
export async function GET(req: Request) {
  try {
    const ctx = await getActingContext(req);
    if (!ctx) return unauthorized();
    assertCan(ctx.role, "finance:read");
    const params = new URL(req.url).searchParams;
    const { kind } = Query.parse(Object.fromEntries(params));
    const timeZone = await getTenantTimezone(ctx.tenantId);
    const period = periodFromSearchParams(params, timeZone);
    const { filename, csv } = await exportFinanceCsv(ctx.tenantId, kind, period, timeZone);
    return csvResponse(filename, csv);
  } catch (err) {
    return handleApiError(err);
  }
}

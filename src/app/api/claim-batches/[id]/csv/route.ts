import { NextResponse } from "next/server";
import { handleApiError, unauthorized } from "@/lib/api";
import { batchCsv } from "@/modules/insurance/batches";
import { financeErrorResponse } from "../../../procedures/_lib/errors";
import { expenseContext, type IdParams } from "../../../expenses/_lib/context";

export const dynamic = "force-dynamic";

/** `GET /api/claim-batches/[id]/csv` (`insurance:read`) — the batch as the payer gets it, a line for each piece of work. */
export async function GET(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    const c = await expenseContext(req, "insurance:read");
    if (!c) return unauthorized();
    const { filename, csv } = await batchCsv(c.ctx.tenantId, id);
    return new NextResponse(csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`, "cache-control": "no-store" },
    });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

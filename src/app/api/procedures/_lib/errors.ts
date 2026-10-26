import { NextResponse } from "next/server";
import { FinanceError } from "@/modules/finance/errors";

/**
 * HTTP mapping for the finance module's domain errors (procedures, payments,
 * imports). Returns null for anything else so handlers fall through to the
 * shared `handleApiError`.
 */
export function financeErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof FinanceError) {
    return NextResponse.json({ error: err.code, ...err.extra }, { status: err.status });
  }
  return null;
}

import { NextResponse } from "next/server";
import { CheckInValidationError, ConciergeError, ConciergeNotFoundError } from "@/modules/concierge/errors";

/**
 * HTTP mapping for the concierge module's domain errors. Returns null for
 * anything else so handlers fall through to the shared `handleApiError`.
 *
 *  - answers (or roster entries) that fail validation → 422 in the shape of a
 *    zod error (`issues.fieldErrors`), so `fieldErrors()` in lib/http reads it;
 *  - a missing or foreign-tenant id → 404 `{ error: "not_found", entity }`;
 *  - everything else → its own status with `{ error: code, message }`.
 */
export function conciergeErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof CheckInValidationError) {
    return NextResponse.json(
      { error: "validation_error", message: err.message, issues: { formErrors: [], fieldErrors: err.fieldErrors } },
      { status: 422 },
    );
  }
  if (err instanceof ConciergeNotFoundError) {
    return NextResponse.json({ error: "not_found", entity: err.entity }, { status: 404 });
  }
  if (err instanceof ConciergeError) {
    if (err.status === 404) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, { status: err.status });
  }
  return null;
}

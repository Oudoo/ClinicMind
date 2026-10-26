import { NextResponse } from "next/server";
import { IntakeError } from "@/modules/intake/service";

/** HTTP mapping for the intake service's domain errors; null falls through to `handleApiError`. */
export function intakeErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof IntakeError) {
    if (err.status === 404) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return null;
}

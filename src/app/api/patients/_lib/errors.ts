import { NextResponse } from "next/server";
import { DuplicatePatientError } from "@/modules/patients/service";

/**
 * HTTP mapping for the patient service's domain errors. Returns null for
 * anything else so handlers fall through to the shared `handleApiError`.
 */
export function patientErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof DuplicatePatientError) {
    // 409 duplicate_phone / duplicate_national_id with the patients it matched; resend with confirmDuplicate: true to save anyway.
    return NextResponse.json({ error: err.code, message: err.message, matches: err.matches }, { status: 409 });
  }
  return null;
}

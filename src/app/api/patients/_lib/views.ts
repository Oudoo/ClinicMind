import { NextResponse } from "next/server";
import { SavedViewLimitError } from "@/modules/patients/views";

/** Saved views belong to a signed-in staff user; an embed session without one cannot keep any. */
export function noUser(): NextResponse {
  return NextResponse.json({ error: "forbidden", message: "Saved views need a signed-in user" }, { status: 403 });
}

/** HTTP mapping for the saved-view domain errors; null falls through to `handleApiError`. */
export function savedViewErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof SavedViewLimitError) {
    return NextResponse.json({ error: "limit_reached", message: err.message }, { status: 409 });
  }
  return null;
}

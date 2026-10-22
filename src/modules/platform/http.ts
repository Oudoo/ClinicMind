import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api";
import { PlatformError } from "./service";

/** Map platform-level refusals (reserved slug, taken slug or domain, unknown tenant) to JSON. */
export function handlePlatformError(err: unknown) {
  if (err instanceof PlatformError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  }
  return handleApiError(err);
}

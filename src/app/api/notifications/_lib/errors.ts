import { NextResponse } from "next/server";
import { NotificationUserNotFoundError } from "@/modules/notifications/service";

/**
 * HTTP mapping for the notification service's domain errors. Returns null for
 * anything else so handlers fall through to the shared `handleApiError`.
 */
export function notificationErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof NotificationUserNotFoundError) {
    return NextResponse.json({ error: "not_found", entity: "user" }, { status: 404 });
  }
  return null;
}

/** Polling endpoints: never let a proxy or the browser cache the answer. */
export const NO_STORE = { headers: { "Cache-Control": "no-store, max-age=0" } } as const;

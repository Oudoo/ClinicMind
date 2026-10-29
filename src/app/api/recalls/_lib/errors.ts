import { NextResponse } from "next/server";
import type { ActingContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import { appointmentErrorResponse } from "@/app/api/appointments/_lib/errors";
import { RecallError, type Actor } from "@/modules/recalls/service";

/**
 * HTTP mapping for the recall service's errors (and the appointment errors a
 * booking can raise). Null for anything else, so handlers fall through to
 * the shared `handleApiError`.
 */
export function recallErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof RecallError) {
    return NextResponse.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
  }
  return appointmentErrorResponse(err);
}

export function actorOf(ctx: ActingContext, req: Request): Actor {
  return { id: ctx.userId, email: ctx.email, ip: clientIp(req), role: ctx.role };
}

export type Params = { params: Promise<{ id: string }> };

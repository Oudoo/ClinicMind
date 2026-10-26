import { NextResponse } from "next/server";
import type { ActingContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import { DuplicateTemplateError } from "@/modules/messaging/templates";

/** HTTP mapping for the messaging module's domain errors; null falls through to `handleApiError`. */
export function messagingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof DuplicateTemplateError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
  }
  return null;
}

export function actorOf(ctx: ActingContext, req: Request) {
  return { id: ctx.userId, email: ctx.email, ip: clientIp(req) };
}

export type Params = { params: Promise<{ id: string }> };

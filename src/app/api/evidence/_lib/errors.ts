import { NextResponse } from "next/server";
import type { ActingContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import { EvidenceError, type Actor } from "@/modules/evidence/service";

/** HTTP mapping for the evidence service's errors; null for anything else (the shared `handleApiError` takes it). */
export function evidenceErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof EvidenceError) return NextResponse.json({ error: err.code, message: err.message }, { status: err.status });
  return null;
}

export function actorOf(ctx: ActingContext, req: Request): Actor {
  return { id: ctx.userId, email: ctx.email, ip: clientIp(req) };
}

export type Params = { params: Promise<{ id: string }> };

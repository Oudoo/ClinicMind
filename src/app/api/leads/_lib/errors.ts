import { NextResponse } from "next/server";
import type { ActingContext } from "@/lib/auth/session";
import { clientIp } from "@/lib/auth/request";
import { appointmentErrorResponse } from "@/app/api/appointments/_lib/errors";
import { CrmValidationError, LeadStageError, LeadStateError, type Actor } from "@/modules/crm/service";

/**
 * HTTP mapping for the CRM service's domain errors (and the appointment
 * errors a consultation booking can raise). Returns null for anything else so
 * handlers fall through to the shared `handleApiError`.
 */
export function crmErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof LeadStageError) {
    return NextResponse.json({ error: "invalid_stage", from: err.from, to: err.to, message: err.reason }, { status: 409 });
  }
  if (err instanceof LeadStateError) {
    return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
  }
  if (err instanceof CrmValidationError) {
    return NextResponse.json({ error: "validation_error", issues: { formErrors: [], fieldErrors: err.fieldErrors } }, { status: 422 });
  }
  return appointmentErrorResponse(err);
}

export function actorOf(ctx: ActingContext, req: Request): Actor {
  return { id: ctx.userId, email: ctx.email, ip: clientIp(req) };
}

export type Params = { params: Promise<{ id: string }> };

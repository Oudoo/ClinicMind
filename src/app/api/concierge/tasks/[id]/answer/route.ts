import { NextResponse } from "next/server";
import { handleApiError, ok, unauthorized } from "@/lib/api";
import { crossOriginRejected, isSameOrigin } from "@/lib/auth/request";
import { MAX_BODY_BYTES, parsePhotoPayload, submitCheckIn } from "@/modules/concierge/checkins";
import { toEscalationDTOs } from "@/modules/concierge/escalations";
import { toCheckInDTO } from "@/modules/concierge/shared";
import { conciergeContext, objectBody, type IdParams } from "../../../_lib/context";
import { conciergeErrorResponse } from "../../../_lib/errors";

export const dynamic = "force-dynamic";

/**
 * `POST /api/concierge/tasks/[id]/answer` — staff record the patient's answers
 * from a phone call (source "staff"). Body `{ answers, satisfaction?,
 * freeText?, photos?: [{ view?, name?, type?, data(base64) }] }`; questions
 * may be left out (only what the patient said is recorded). Triage, the
 * escalation and the notifications run exactly as for the patient's link.
 * → 201 `{ checkIn, triage, flags, escalation, callbackMinutes }`; 422 with
 * `issues.fieldErrors` per question; 409 when already answered.
 */
export async function POST(req: Request, { params }: IdParams) {
  try {
    const { id } = await params;
    if (!isSameOrigin(req)) return crossOriginRejected();
    const c = await conciergeContext(req, "concierge:write");
    if (!c) return unauthorized();
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return NextResponse.json({ error: "payload_too_large", message: "The photos are too large together" }, { status: 413 });
    const body = await objectBody(req);
    const result = await submitCheckIn(c.ctx.tenantId, id, {
      answers: body.answers,
      satisfaction: body.satisfaction,
      freeText: body.freeText,
      photos: parsePhotoPayload(body.photos),
      source: "staff",
      actor: c.actor,
    });
    const [escalation] = result.escalation ? await toEscalationDTOs(c.ctx.tenantId, [result.escalation]) : [null];
    return ok(
      { checkIn: toCheckInDTO(result.checkIn), triage: result.triage, flags: result.flags, escalation: escalation ?? null, callbackMinutes: result.callbackMinutes },
      { status: 201 },
    );
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

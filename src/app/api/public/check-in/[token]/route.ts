import { NextResponse } from "next/server";
import { handleApiError, notFound, tooManyRequests } from "@/lib/api";
import { rateLimit } from "@/lib/auth/rate-limit";
import { clientIp } from "@/lib/auth/request";
import { withTenant } from "@/lib/db";
import {
  CHECK_IN_PUBLIC_GET_LIMIT,
  CHECK_IN_PUBLIC_POST_LIMIT,
  CHECK_IN_RATE_WINDOW_MS,
  getPublicCheckIn,
  MAX_BODY_BYTES,
  parsePhotoPayload,
  submitByToken,
  toPublicResult,
} from "@/modules/concierge/checkins";
import { getClinicInfo } from "@/modules/concierge/shared";
import { conciergeErrorResponse } from "../../../concierge/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

/**
 * `GET /api/public/check-in/[token]` — what the patient's check-in page
 * needs: `{ clinicName, clinicPhone, language, patientFirstName, status, late,
 * limits, step: { kind, heading, dayLabel, body, questions, satisfaction,
 * photos } }`. No session: the token is the credential (looked up by its
 * hash). Unknown, used, expired and stopped links are all the same plain 404,
 * and the token is never echoed back.
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const limit = rateLimit(`check-in:get:ip:${clientIp(req) ?? "unknown"}`, CHECK_IN_PUBLIC_GET_LIMIT, CHECK_IN_RATE_WINDOW_MS);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
    const { token } = await params;
    const checkIn = await getPublicCheckIn(token);
    if (!checkIn) return notFound();
    return NextResponse.json(checkIn, { headers: NO_STORE });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `POST /api/public/check-in/[token]` with `{ answers: { [questionKey]: value },
 * satisfaction?: 1–5, freeText?, photos?: [{ view, name?, type?, data }] }`
 * (photos as base64, at most 4 of 5 MB each, the whole body at most 9 MB) →
 * `{ ok, triage, clinicPhone, callbackMinutes, outOfHours }`. A HIGH_RISK
 * answer opens an escalation assigned per the roster (15 minutes in hours, 30
 * out of hours) before this returns, and `callbackMinutes` says so. 422 with
 * `issues.fieldErrors` per question, 413 when too large, 404 for a dead link
 * (including one answered a moment ago), 429 when an address submits too often.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const ip = clientIp(req);
    const limit = rateLimit(`check-in:post:ip:${ip ?? "unknown"}`, CHECK_IN_PUBLIC_POST_LIMIT, CHECK_IN_RATE_WINDOW_MS);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
    const { token } = await params;

    const tooLarge = () => NextResponse.json({ error: "payload_too_large", message: "The photos are too large together" }, { status: 413, headers: NO_STORE });
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return tooLarge();
    let raw: unknown;
    try {
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ error: "validation_error", message: "The answers could not be read" }, { status: 422, headers: NO_STORE });
    }
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

    const result = await submitByToken(token, {
      answers: body.answers,
      satisfaction: body.satisfaction,
      freeText: body.freeText,
      photos: parsePhotoPayload(body.photos),
      actor: { ip },
    });
    // The token resolved to this clinic: read its phone in that clinic's database scope.
    const clinic = await withTenant(result.checkIn.tenantId, () => getClinicInfo(result.checkIn.tenantId));
    return NextResponse.json(toPublicResult(result, clinic.phone), { headers: NO_STORE });
  } catch (err) {
    return conciergeErrorResponse(err) ?? handleApiError(err);
  }
}

import { NextResponse } from "next/server";
import { handleApiError, notFound, tooManyRequests } from "@/lib/api";
import { rateLimit } from "@/lib/auth/rate-limit";
import { clientIp } from "@/lib/auth/request";
import {
  INTAKE_PUBLIC_GET_LIMIT,
  INTAKE_PUBLIC_POST_LIMIT,
  INTAKE_RATE_WINDOW_MS,
  getPublicIntake,
  submitPublicIntake,
} from "@/modules/intake/service";
import { intakeErrorResponse } from "../../../intake/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * `GET /api/public/intake/[token]` — what the onboarding page needs:
 * `{ clinicName, productName, language, kind, prefill, treatments }`.
 * No session: the token is the credential. Unknown, expired, revoked and
 * used-up tokens are all a plain 404; the token is never echoed back.
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const ip = clientIp(req) ?? "unknown";
    const limit = rateLimit(`intake:get:ip:${ip}`, INTAKE_PUBLIC_GET_LIMIT, INTAKE_RATE_WINDOW_MS);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

    const { token } = await params;
    const intake = await getPublicIntake(token);
    if (!intake) return notFound();
    return NextResponse.json(intake, { headers: NO_STORE });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `POST /api/public/intake/[token]` with the form (see `IntakeFormInput`) →
 * `{ ok: true }`; 422 with field errors, 404 for a dead token, 429 when an IP
 * submits too often. Creates the PENDING submission, bumps the link's uses
 * and notifies reception.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const ip = clientIp(req) ?? "unknown";
    const limit = rateLimit(`intake:post:ip:${ip}`, INTAKE_PUBLIC_POST_LIMIT, INTAKE_RATE_WINDOW_MS);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

    const { token } = await params;
    const body: unknown = await req.json().catch(() => null);
    const result = await submitPublicIntake(token, body ?? {}, { ip: clientIp(req) });
    if (!result) return notFound();
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    return intakeErrorResponse(err) ?? handleApiError(err);
  }
}

import { NextResponse } from "next/server";
import { handleApiError, notFound, tooManyRequests } from "@/lib/api";
import { rateLimit } from "@/lib/auth/rate-limit";
import { clientIp } from "@/lib/auth/request";
import { answerByToken, quoteByToken } from "@/modules/quotes/service";
import { financeErrorResponse } from "../../../procedures/_lib/errors";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ token: string }> };

const NO_STORE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const WINDOW_MS = 15 * 60_000;
const GET_LIMIT = 60;
const POST_LIMIT = 20;
/** A signature is at most 40,000 characters; the rest of an answer is small. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * `GET /api/public/quotes/[token]` — the treatment plan behind the patient's
 * link, without the clinic's internal notes. No session: the token is the
 * credential (looked up by its hash); an unknown link, or one replaced by a
 * newer link, is a plain 404.
 */
export async function GET(req: Request, { params }: Params) {
  try {
    const limit = rateLimit(`quote:get:ip:${clientIp(req) ?? "unknown"}`, GET_LIMIT, WINDOW_MS);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
    const { token } = await params;
    const quote = await quoteByToken(token);
    if (!quote) return notFound();
    return NextResponse.json({ quote }, { headers: NO_STORE });
  } catch (err) {
    return handleApiError(err);
  }
}

/**
 * `POST /api/public/quotes/[token]` with `{ action: "accept", itemIds, name, signature, agree: true }`
 * or `{ action: "decline", reason? }` → `{ quote }`. Accepting makes the items chosen planned
 * procedures at the quoted prices; the doctor and the front desk are told either way. 409 when the
 * quote is no longer open (expired, answered or withdrawn), 422 with the issues, 429 when an address
 * answers too often.
 */
export async function POST(req: Request, { params }: Params) {
  try {
    const ip = clientIp(req);
    const limit = rateLimit(`quote:post:ip:${ip ?? "unknown"}`, POST_LIMIT, WINDOW_MS);
    if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
    const { token } = await params;
    const tooLarge = () => NextResponse.json({ error: "payload_too_large" }, { status: 413, headers: NO_STORE });
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return tooLarge();
    let body: unknown;
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json({ error: "validation_error", message: "The answer could not be read" }, { status: 422, headers: NO_STORE });
    }
    const quote = await answerByToken(token, body, { ip });
    if (!quote) return notFound();
    return NextResponse.json({ quote }, { headers: NO_STORE });
  } catch (err) {
    return financeErrorResponse(err) ?? handleApiError(err);
  }
}

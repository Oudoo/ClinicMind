import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { db, notDeleted, withTenant } from "@/lib/db";
import { rateLimit } from "@/lib/auth/rate-limit";
import {
  InboundPayload,
  ReceiptPayload,
  applyDeliveryReceipts,
  handleInbound,
  isReceiptPayload,
  parseMetaPayload,
  parseMetaStatuses,
  type DeliveryReceipt,
  type InboundMessage,
} from "@/modules/messaging/inbound";
import { META_SIGNATURE_HEADER, SIGNATURE_HEADER, configOf, integrationSecret, signatureMatches } from "@/modules/messaging/provider";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ tenantSlug: string }> };

const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;
const INBOUND_LIMIT = 300;
const INBOUND_WINDOW_MS = 60_000;
const VERIFY_LIMIT = 30;
/** A webhook delivery is a few kilobytes; anything near a megabyte is not one. */
const MAX_BODY_BYTES = 1_000_000;

function deny(status: 401 | 403 | 413 | 429, error = "unauthorized", retryAfterSeconds?: number) {
  return NextResponse.json(
    retryAfterSeconds ? { error, retryAfterSeconds } : { error },
    { status, headers: { ...NO_STORE.headers, ...(retryAfterSeconds ? { "Retry-After": String(retryAfterSeconds) } : {}) } },
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function findTenant(slug: string) {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  return db.tenant.findFirst({ where: { slug, status: "ACTIVE", ...notDeleted }, select: { id: true, slug: true } });
}

/**
 * `GET /api/integrations/messaging/inbound/[tenantSlug]?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
 * — Meta's webhook verification handshake: answers the challenge when the
 * verify token equals `WHATSAPP_VERIFY_TOKEN`.
 */
export async function GET(req: Request, { params }: Params) {
  const { tenantSlug } = await params;
  const limit = rateLimit(`inbound-verify:${tenantSlug}`, VERIFY_LIMIT, INBOUND_WINDOW_MS);
  if (!limit.ok) return deny(429, "rate_limited", limit.retryAfterSeconds);
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token") ?? "";
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const expected = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
  const tenant = await findTenant(tenantSlug);
  if (!tenant || mode !== "subscribe" || !expected || !token || !constantTimeEqual(token, expected)) return deny(403, "forbidden");
  return new NextResponse(challenge, { status: 200, headers: { "content-type": "text/plain", ...NO_STORE.headers } });
}

/**
 * `POST /api/integrations/messaging/inbound/[tenantSlug]` — inbound messages
 * and delivery receipts. No session: the body is authenticated by its
 * signature, either `X-ClinicMind-Signature` (HMAC-SHA256 of the raw body
 * under the tenant's webhook secret; generic JSON `{ from, body, name?,
 * externalId?, ref?, channel? }` or an array of them, or a receipt
 * `{ event: "message.status", messageId | externalId, status }`) or, for a
 * WhatsApp Cloud integration, Meta's `X-Hub-Signature-256` under
 * `WHATSAPP_APP_SECRET` with Meta's payload (`messages[]` and `statuses[]`).
 * Rate-limited per tenant and capped at 1 MB; a bad or missing signature, an
 * unknown tenant and a missing integration all look the same (401). Retries
 * with the same message id are accepted once.
 */
export async function POST(req: Request, { params }: Params) {
  const { tenantSlug } = await params;
  const limit = rateLimit(`inbound:${tenantSlug}`, INBOUND_LIMIT, INBOUND_WINDOW_MS);
  if (!limit.ok) return deny(429, "rate_limited", limit.retryAfterSeconds);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return deny(413, "payload_too_large");

  const tenant = await findTenant(tenantSlug);
  if (!tenant) return deny(401);
  // Everything after runs in the clinic's database scope (row-level security, lib/db.ts).
  return withTenant(tenant.id, () => receive(req, tenant));
}

async function receive(req: Request, tenant: { id: string; slug: string }): Promise<NextResponse> {
  const integration = await db.channelIntegration.findUnique({ where: { tenantId_channel: { tenantId: tenant.id, channel: "WHATSAPP" } } });
  if (!integration) return deny(401);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return deny(413, "payload_too_large");
  const ownSignature = req.headers.get(SIGNATURE_HEADER);
  const metaSignature = req.headers.get(META_SIGNATURE_HEADER);

  let messages: InboundMessage[] = [];
  let receipts: DeliveryReceipt[] = [];
  try {
    if (ownSignature) {
      const secret = integrationSecret(configOf(integration.config));
      if (!secret || !signatureMatches(secret, raw, ownSignature)) return deny(401);
      const json: unknown = JSON.parse(raw);
      const items = Array.isArray(json) ? json.slice(0, 50) : [json];
      for (const item of items) {
        if (isReceiptPayload(item)) receipts.push(ReceiptPayload.parse(item));
        else messages.push(InboundPayload.parse(item));
      }
    } else if (metaSignature) {
      const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
      if (integration.provider !== "whatsapp_cloud" || !appSecret || !signatureMatches(appSecret, raw, metaSignature)) return deny(401);
      const json: unknown = JSON.parse(raw);
      messages = parseMetaPayload(json);
      receipts = parseMetaStatuses(json);
    } else {
      return deny(401);
    }
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: "validation_error", issues: err.flatten() }, { status: 422, ...NO_STORE });
    }
    return NextResponse.json({ error: "invalid_payload" }, { status: 400, ...NO_STORE });
  }

  const results = [];
  for (const message of messages) {
    try {
      const r = await handleInbound(tenant.id, message);
      results.push({ conversationId: r.conversationId, messageId: r.messageId, leadId: r.leadId, duplicate: r.duplicate });
    } catch (err) {
      console.error("[messaging] inbound message failed", err);
      results.push({ error: "failed" });
    }
  }
  let receiptsApplied = 0;
  if (receipts.length) {
    try {
      receiptsApplied = await applyDeliveryReceipts(tenant.id, receipts);
    } catch (err) {
      console.error("[messaging] delivery receipts failed", err);
    }
  }
  return NextResponse.json({ accepted: results.length, results, receipts: receiptsApplied }, { status: 200, ...NO_STORE });
}

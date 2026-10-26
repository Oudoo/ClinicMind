import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ChannelType, MessageDelivery } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/ai/tenant-config";

/**
 * Delivery adapters behind `sendPatientMessage`. The tenant's ChannelIntegration
 * decides the path:
 *
 *   - `whatsapp_cloud` — Meta's WhatsApp Cloud API: POST
 *     graph.facebook.com/v20.0/<phoneNumberId>/messages with the access token
 *     from `WHATSAPP_CLOUD_TOKEN` (server env, never stored per tenant).
 *   - `inbox_webhook` — the clinic's own inbox: POST the message JSON to the
 *     configured URL, signed with HMAC-SHA256 (`X-ClinicMind-Signature`) under
 *     the integration's secret. The secret is kept encrypted (AES-256-GCM via
 *     lib/ai/tenant-config) because signing needs the raw value; its hash and
 *     prefix are stored beside it for display and inbound verification.
 *   - `manual` or nothing configured — the message is LOGGED on the record.
 *
 * A failed send never throws: it comes back as FAILED with a reason.
 */
export const PROVIDERS = ["manual", "whatsapp_cloud", "inbox_webhook"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const SIGNATURE_HEADER = "x-clinicmind-signature";
export const META_SIGNATURE_HEADER = "x-hub-signature-256";
export const GRAPH_API_BASE = "https://graph.facebook.com/v20.0";
export const PROVIDER_TIMEOUT_MS = 10_000;

export interface IntegrationConfig {
  phoneNumberId?: string;
  outboundUrl?: string;
  /** AES-256-GCM ciphertext of the webhook secret (lib/ai/tenant-config). */
  secretEncrypted?: string;
}

export function configOf(value: unknown): IntegrationConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const out: IntegrationConfig = {};
  if (typeof v.phoneNumberId === "string" && v.phoneNumberId) out.phoneNumberId = v.phoneNumberId;
  if (typeof v.outboundUrl === "string" && v.outboundUrl) out.outboundUrl = v.outboundUrl;
  if (typeof v.secretEncrypted === "string" && v.secretEncrypted) out.secretEncrypted = v.secretEncrypted;
  return out;
}

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

// ── Signatures & secrets ─────────────────────────────────────────────────────

/** `sha256=<hex>` of HMAC-SHA256(secret, rawBody): the format Meta uses too. */
export function signBody(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

/** Constant-time check of a presented signature (with or without the `sha256=` prefix). */
export function signatureMatches(secret: string, rawBody: string, presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = signBody(secret, rawBody).slice("sha256=".length);
  const given = presented.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(given) || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export function hashWebhookSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** A fresh webhook secret: the raw value (shown once), its hash, prefix and ciphertext. */
export function generateWebhookSecret(): { raw: string; hash: string; prefix: string; encrypted: string } {
  const raw = `cmwh_${randomBytes(24).toString("base64url")}`;
  return { raw, hash: hashWebhookSecret(raw), prefix: raw.slice(0, 10), encrypted: encryptSecret(raw) };
}

/** The raw webhook secret of an integration, or null when none is set or it no longer decrypts. */
export function integrationSecret(config: IntegrationConfig): string | null {
  if (!config.secretEncrypted) return null;
  try {
    return decryptSecret(config.secretEncrypted);
  } catch {
    return null;
  }
}

// ── Delivery ─────────────────────────────────────────────────────────────────

export interface DeliveryRequest {
  tenantId: string;
  channel: ChannelType;
  /** Destination phone (E.164) when known. */
  to: string | null;
  body: string;
  messageId: string;
  conversationId: string;
  meta?: Record<string, unknown>;
}

export interface DeliveryResult {
  delivery: MessageDelivery;
  externalId: string | null;
  failedReason: string | null;
  provider: ProviderName | "none";
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;

/** Test hook: route provider calls through a fake fetch (null restores the real one). */
export function __setMessagingFetchForTests(fn: FetchLike | null): void {
  fetchImpl = fn;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await (fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(err: unknown): string {
  if (err instanceof Error && err.name === "AbortError") return `timeout after ${PROVIDER_TIMEOUT_MS / 1000} s`;
  return err instanceof Error ? err.message : String(err);
}

export async function getIntegration(tenantId: string, channel: ChannelType) {
  return db.channelIntegration.findUnique({ where: { tenantId_channel: { tenantId, channel } } });
}

/** Deliver one outbound message through the tenant's provider for the channel. */
export async function deliverOutbound(req: DeliveryRequest): Promise<DeliveryResult> {
  const integration = await getIntegration(req.tenantId, req.channel).catch(() => null);
  if (!integration || !integration.enabled || !isProvider(integration.provider) || integration.provider === "manual") {
    return { delivery: "LOGGED", externalId: null, failedReason: null, provider: integration?.provider === "manual" ? "manual" : "none" };
  }
  const config = configOf(integration.config);
  const result =
    integration.provider === "whatsapp_cloud" ? await sendViaWhatsAppCloud(req, config) : await sendViaInboxWebhook(req, config, integration.secretHash);
  if (result.delivery === "SENT") {
    db.channelIntegration.update({ where: { id: integration.id }, data: { lastOutboundAt: new Date() } }).catch(() => undefined);
  }
  return result;
}

async function sendViaWhatsAppCloud(req: DeliveryRequest, config: IntegrationConfig): Promise<DeliveryResult> {
  const token = process.env.WHATSAPP_CLOUD_TOKEN?.trim();
  const fail = (reason: string): DeliveryResult => ({ delivery: "FAILED", externalId: null, failedReason: reason, provider: "whatsapp_cloud" });
  if (!token) return fail("WHATSAPP_CLOUD_TOKEN is not set on the server");
  if (!config.phoneNumberId) return fail("No WhatsApp phone number id configured");
  const to = req.to?.replace(/[^0-9]/g, "");
  if (!to) return fail("The contact has no phone number");
  try {
    const res = await timedFetch(`${GRAPH_API_BASE}/${encodeURIComponent(config.phoneNumberId)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: req.body } }),
    });
    const json = (await res.json().catch(() => null)) as { messages?: { id?: string }[]; error?: { message?: string; code?: number } } | null;
    if (!res.ok) return fail(`HTTP ${res.status}${json?.error?.message ? `: ${json.error.message}` : ""}`);
    return { delivery: "SENT", externalId: json?.messages?.[0]?.id ?? null, failedReason: null, provider: "whatsapp_cloud" };
  } catch (err) {
    return fail(describeFailure(err));
  }
}

async function sendViaInboxWebhook(req: DeliveryRequest, config: IntegrationConfig, secretHash: string | null): Promise<DeliveryResult> {
  const fail = (reason: string): DeliveryResult => ({ delivery: "FAILED", externalId: null, failedReason: reason, provider: "inbox_webhook" });
  if (!config.outboundUrl) return fail("No outbound URL configured");
  const secret = integrationSecret(config);
  if (!secret && secretHash) return fail("The webhook secret cannot be read; generate a new one");
  const payload = JSON.stringify({
    event: "message.outbound",
    messageId: req.messageId,
    conversationId: req.conversationId,
    channel: req.channel,
    to: req.to,
    body: req.body,
    sentAt: new Date().toISOString(),
    meta: req.meta ?? {},
  });
  try {
    const res = await timedFetch(config.outboundUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clinicmind-event": "message.outbound",
        ...(secret ? { [SIGNATURE_HEADER]: signBody(secret, payload) } : {}),
      },
      body: payload,
    });
    if (!res.ok) return fail(`HTTP ${res.status}`);
    const json = (await res.json().catch(() => null)) as { id?: string; externalId?: string } | null;
    return { delivery: "SENT", externalId: json?.externalId ?? json?.id ?? null, failedReason: null, provider: "inbox_webhook" };
  } catch (err) {
    return fail(describeFailure(err));
  }
}

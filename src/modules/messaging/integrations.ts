import { z } from "zod";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { requireTenantPatient } from "@/lib/tenant-scope";
import { zText } from "@/lib/validation";
import type { IntegrationStatusDTO } from "./dto";
import { PROVIDERS, configOf, generateWebhookSecret, isProvider, type IntegrationConfig } from "./provider";
import { sendPatientMessage } from "./outbound";

/**
 * The tenant's messaging connection (one ChannelIntegration row for WHATSAPP):
 * which provider delivers outbound messages, the inbound webhook URL and its
 * secret, and a test send. Settings-page territory, owner only.
 */
export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const IntegrationInput = z.object({
  provider: z.enum(PROVIDERS),
  phoneNumberId: z.preprocess(blankToUndefined, z.string().trim().regex(/^[0-9]{6,32}$/, "Digits only").optional()),
  outboundUrl: z.preprocess(blankToUndefined, z.string().trim().url().max(500).refine((u) => /^https?:\/\//.test(u), "Must be an http(s) URL").optional()),
  enabled: z.boolean().optional(),
});
export type IntegrationInput = z.input<typeof IntegrationInput>;

export const TestMessageInput = z.object({ patientId: zText(64).min(1), body: z.preprocess(blankToUndefined, zText(1000).optional()) });

export function inboundWebhookUrl(tenantSlug: string): string {
  return `${(env.PUBLIC_URL ?? env.APP_URL).replace(/\/$/, "")}/api/integrations/messaging/inbound/${tenantSlug}`;
}

export async function getIntegrationStatus(tenantId: string, tenantSlug: string): Promise<IntegrationStatusDTO> {
  const row = await db.channelIntegration.findUnique({ where: { tenantId_channel: { tenantId, channel: "WHATSAPP" } } });
  const config = configOf(row?.config);
  return {
    provider: row && isProvider(row.provider) ? row.provider : "manual",
    enabled: row?.enabled ?? false,
    phoneNumberId: config.phoneNumberId ?? null,
    outboundUrl: config.outboundUrl ?? null,
    secretPrefix: row?.secretPrefix ?? null,
    hasSecret: Boolean(row?.secretHash),
    lastInboundAt: row?.lastInboundAt?.toISOString() ?? null,
    lastOutboundAt: row?.lastOutboundAt?.toISOString() ?? null,
    inboundUrl: inboundWebhookUrl(tenantSlug),
    env: {
      whatsappTokenSet: Boolean(process.env.WHATSAPP_CLOUD_TOKEN?.trim()),
      whatsappAppSecretSet: Boolean(process.env.WHATSAPP_APP_SECRET?.trim()),
      whatsappVerifyTokenSet: Boolean(process.env.WHATSAPP_VERIFY_TOKEN?.trim()),
    },
  };
}

/** Set the provider and its config; `enabled` defaults to on when the provider has what it needs. */
export async function updateIntegration(tenantId: string, tenantSlug: string, rawInput: unknown, actor: Actor = {}): Promise<IntegrationStatusDTO> {
  const input = IntegrationInput.parse(rawInput);
  const existing = await db.channelIntegration.findUnique({ where: { tenantId_channel: { tenantId, channel: "WHATSAPP" } } });
  const current = configOf(existing?.config);
  const next: IntegrationConfig = { ...current };
  if (input.provider === "whatsapp_cloud") {
    if (input.phoneNumberId) next.phoneNumberId = input.phoneNumberId;
    if (!next.phoneNumberId) throw new z.ZodError([{ code: "custom", path: ["phoneNumberId"], message: "A phone number id is required", input: undefined }]);
  }
  if (input.provider === "inbox_webhook") {
    if (input.outboundUrl) next.outboundUrl = input.outboundUrl;
    if (!next.outboundUrl) throw new z.ZodError([{ code: "custom", path: ["outboundUrl"], message: "An outbound URL is required", input: undefined }]);
  }
  const enabled = input.enabled ?? input.provider !== "manual";
  const row = await db.channelIntegration.upsert({
    where: { tenantId_channel: { tenantId, channel: "WHATSAPP" } },
    create: { tenantId, channel: "WHATSAPP", provider: input.provider, config: next as object, enabled },
    update: { provider: input.provider, config: next as object, enabled },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "messaging.integration.update",
    entity: "ChannelIntegration",
    entityId: row.id,
    before: existing ? { provider: existing.provider, enabled: existing.enabled, phoneNumberId: current.phoneNumberId ?? null, outboundUrl: current.outboundUrl ?? null } : null,
    after: { provider: row.provider, enabled: row.enabled, phoneNumberId: next.phoneNumberId ?? null, outboundUrl: next.outboundUrl ?? null },
  });
  return getIntegrationStatus(tenantId, tenantSlug);
}

/**
 * Generate (or rotate) the webhook secret. The raw value is returned exactly
 * once; the row keeps its hash and prefix, and the ciphertext the outbound
 * signer needs.
 */
export async function rotateWebhookSecret(tenantId: string, actor: Actor = {}): Promise<{ secret: string; prefix: string; rotatedAt: string }> {
  const generated = generateWebhookSecret();
  const existing = await db.channelIntegration.findUnique({ where: { tenantId_channel: { tenantId, channel: "WHATSAPP" } } });
  const config: IntegrationConfig = { ...configOf(existing?.config), secretEncrypted: generated.encrypted };
  const row = await db.channelIntegration.upsert({
    where: { tenantId_channel: { tenantId, channel: "WHATSAPP" } },
    create: { tenantId, channel: "WHATSAPP", provider: "manual", config: config as object, secretHash: generated.hash, secretPrefix: generated.prefix, enabled: false },
    update: { config: config as object, secretHash: generated.hash, secretPrefix: generated.prefix },
  });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "messaging.integration.secret",
    entity: "ChannelIntegration",
    entityId: row.id,
    before: { secretPrefix: existing?.secretPrefix ?? null },
    after: { secretPrefix: generated.prefix },
  });
  return { secret: generated.raw, prefix: generated.prefix, rotatedAt: row.updatedAt.toISOString() };
}

/** Send a test message to a patient through whatever is connected and report how it went. */
export async function sendTestMessage(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = TestMessageInput.parse(rawInput);
  await requireTenantPatient(tenantId, input.patientId);
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  const result = await sendPatientMessage(tenantId, {
    patientId: input.patientId,
    body: input.body ?? `Test message from ${tenant?.name ?? "the clinic"} — please ignore.`,
    author: "SYSTEM",
    authorId: actor.id ?? null,
    meta: { test: true },
  });
  const message = await db.message.findFirst({ where: { id: result.messageId, tenantId }, select: { delivery: true, failedReason: true, externalId: true } });
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "messaging.integration.test",
    entity: "Conversation",
    entityId: result.conversationId,
    after: { messageId: result.messageId, delivery: result.delivery, failedReason: message?.failedReason ?? null },
  });
  return { ...result, failedReason: message?.failedReason ?? null, externalId: message?.externalId ?? null };
}

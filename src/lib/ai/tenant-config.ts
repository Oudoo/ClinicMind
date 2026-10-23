import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { env } from "@/lib/env";
import { db } from "@/lib/db";
import type { TenantAiOverrides, VendorName } from "./provider";
import type { ProviderConfig } from "./types";

/**
 * Per-tenant AI configuration, stored under `Tenant.settings.ai`.
 *
 * A client may bring its own provider keys and models (one clinic on Gemini,
 * another on OpenAI or Claude) and choose which provider answers chat and
 * which one transcribes. Keys are encrypted at rest with AES-256-GCM under
 * `DATA_ENCRYPTION_KEY` (or a key derived from `AUTH_SECRET`), are never
 * returned to any client, and only a key's last four characters are kept in
 * clear as a hint. Embeddings are not configurable per tenant: the vector
 * store has one dimension and one model.
 */
export const VENDORS = ["gemini", "openai", "anthropic"] as const;
const CHAT_CHOICES = ["inherit", "gemini", "openai", "anthropic"] as const;
const TRANSCRIPTION_CHOICES = ["inherit", "gemini", "openai"] as const;

const zModel = z.string().trim().max(80);
const zKey = z.string().trim().max(400);

/** PATCH contract. `inherit` or `""` clears an override; an undefined field keeps what is stored. */
export const TenantAiInput = z
  .object({
    chatProvider: z.enum(CHAT_CHOICES).optional(),
    transcriptionProvider: z.enum(TRANSCRIPTION_CHOICES).optional(),
    models: z
      .object({
        geminiChat: zModel.optional(),
        openaiChat: zModel.optional(),
        anthropicChat: zModel.optional(),
        geminiTranscription: zModel.optional(),
        openaiTranscription: zModel.optional(),
      })
      .strict()
      .optional(),
    /** A new key replaces the stored one; an empty string removes it; undefined keeps it. */
    keys: z.object({ gemini: zKey.optional(), openai: zKey.optional(), anthropic: zKey.optional() }).strict().optional(),
  })
  .strict();
export type TenantAiPatch = z.infer<typeof TenantAiInput>;

type ModelKey = keyof NonNullable<TenantAiPatch["models"]>;
const MODEL_KEYS: ModelKey[] = ["geminiChat", "openaiChat", "anthropicChat", "geminiTranscription", "openaiTranscription"];

interface StoredKey {
  enc: string;
  hint: string;
}

export interface TenantAiConfig {
  chatProvider?: VendorName;
  transcriptionProvider?: "gemini" | "openai";
  models?: Partial<Record<ModelKey, string>>;
  keys?: Partial<Record<VendorName, StoredKey>>;
}

/** What the console sees: providers, models and whether a key is set (never the key). */
export interface TenantAiPublic {
  chatProvider: (typeof CHAT_CHOICES)[number];
  transcriptionProvider: (typeof TRANSCRIPTION_CHOICES)[number];
  models: Partial<Record<ModelKey, string>>;
  keys: Record<VendorName, { set: boolean; hint: string | null }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The stored config as a typed object; unknown shapes are tolerated and dropped. */
export function aiConfigOf(settings: unknown): TenantAiConfig {
  if (!isRecord(settings) || !isRecord(settings.ai)) return {};
  const ai = settings.ai;
  const out: TenantAiConfig = {};
  if (ai.chatProvider === "gemini" || ai.chatProvider === "openai" || ai.chatProvider === "anthropic") out.chatProvider = ai.chatProvider;
  if (ai.transcriptionProvider === "gemini" || ai.transcriptionProvider === "openai") out.transcriptionProvider = ai.transcriptionProvider;
  if (isRecord(ai.models)) {
    const models: Partial<Record<ModelKey, string>> = {};
    for (const key of MODEL_KEYS) {
      const value = ai.models[key];
      if (typeof value === "string" && value.trim()) models[key] = value.trim().slice(0, 80);
    }
    if (Object.keys(models).length) out.models = models;
  }
  if (isRecord(ai.keys)) {
    const keys: Partial<Record<VendorName, StoredKey>> = {};
    for (const vendor of VENDORS) {
      const value = ai.keys[vendor];
      if (isRecord(value) && typeof value.enc === "string" && value.enc) keys[vendor] = { enc: value.enc, hint: typeof value.hint === "string" ? value.hint : "" };
    }
    if (Object.keys(keys).length) out.keys = keys;
  }
  return out;
}

/** Apply a PATCH: named fields override, `inherit`/empty strings clear, undefined keeps. */
export function mergeAiConfig(current: TenantAiConfig, patch: TenantAiPatch): TenantAiConfig {
  const next: TenantAiConfig = { ...current, models: { ...(current.models ?? {}) }, keys: { ...(current.keys ?? {}) } };
  if (patch.chatProvider !== undefined) {
    if (patch.chatProvider === "inherit") delete next.chatProvider;
    else next.chatProvider = patch.chatProvider;
  }
  if (patch.transcriptionProvider !== undefined) {
    if (patch.transcriptionProvider === "inherit") delete next.transcriptionProvider;
    else next.transcriptionProvider = patch.transcriptionProvider;
  }
  if (patch.models) {
    for (const key of MODEL_KEYS) {
      const value = patch.models[key];
      if (value === undefined) continue;
      if (value === "") delete next.models![key];
      else next.models![key] = value;
    }
  }
  if (patch.keys) {
    for (const vendor of VENDORS) {
      const value = patch.keys[vendor];
      if (value === undefined) continue;
      if (value === "") delete next.keys![vendor];
      else next.keys![vendor] = { enc: encryptSecret(value), hint: value.slice(-4) };
    }
  }
  if (!Object.keys(next.models!).length) delete next.models;
  if (!Object.keys(next.keys!).length) delete next.keys;
  return next;
}

export function publicAiConfig(cfg: TenantAiConfig): TenantAiPublic {
  const keys = {} as TenantAiPublic["keys"];
  for (const vendor of VENDORS) {
    const stored = cfg.keys?.[vendor];
    keys[vendor] = { set: Boolean(stored), hint: stored ? `…${stored.hint}` : null };
  }
  return {
    chatProvider: cfg.chatProvider ?? "inherit",
    transcriptionProvider: cfg.transcriptionProvider ?? "inherit",
    models: { ...(cfg.models ?? {}) },
    keys,
  };
}

/** Decrypted overrides for the provider registry; a key that no longer decrypts is treated as unset. */
export function overridesFrom(cfg: TenantAiConfig): TenantAiOverrides | undefined {
  const overrides: TenantAiOverrides = {};
  if (cfg.chatProvider) overrides.chatProvider = cfg.chatProvider;
  if (cfg.transcriptionProvider) overrides.transcriptionProvider = cfg.transcriptionProvider;
  const config: NonNullable<TenantAiOverrides["config"]> = {};
  const m = cfg.models ?? {};
  const add = (vendor: VendorName, patch: ProviderConfig) => {
    const clean: ProviderConfig = {};
    if (patch.apiKey) clean.apiKey = patch.apiKey;
    if (patch.chatModel) clean.chatModel = patch.chatModel;
    if (patch.embeddingModel) clean.embeddingModel = patch.embeddingModel;
    if (patch.transcriptionModel) clean.transcriptionModel = patch.transcriptionModel;
    if (Object.keys(clean).length) config[vendor] = { ...(config[vendor] ?? {}), ...clean };
  };
  add("gemini", { chatModel: m.geminiChat, transcriptionModel: m.geminiTranscription, apiKey: decryptStored(cfg.keys?.gemini) });
  add("openai", { chatModel: m.openaiChat, transcriptionModel: m.openaiTranscription, apiKey: decryptStored(cfg.keys?.openai) });
  add("anthropic", { chatModel: m.anthropicChat, apiKey: decryptStored(cfg.keys?.anthropic) });
  if (Object.keys(config).length) overrides.config = config;
  return Object.keys(overrides).length ? overrides : undefined;
}

function decryptStored(stored: StoredKey | undefined): string | undefined {
  if (!stored) return undefined;
  try {
    return decryptSecret(stored.enc);
  } catch {
    return undefined;
  }
}

// ── Encryption (AES-256-GCM) ─────────────────────────────────────────────────

function encryptionKey(): Buffer {
  const material = env.DATA_ENCRYPTION_KEY ?? `${env.AUTH_SECRET}:tenant-ai-keys`;
  return createHash("sha256").update(material).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(encoded: string): string {
  const [version, iv, tag, ciphertext] = encoded.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("unsupported ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

// ── Resolution with a short cache ────────────────────────────────────────────

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: TenantAiOverrides | undefined }>();

/** The tenant's provider overrides for this request (cached 30 s; `undefined` means environment defaults). */
export async function resolveTenantAi(tenantId: string): Promise<TenantAiOverrides | undefined> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const row = await db.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }).catch(() => null);
  const value = overridesFrom(aiConfigOf(row?.settings));
  cache.set(tenantId, { at: Date.now(), value });
  return value;
}

export function invalidateTenantAi(tenantId: string): void {
  cache.delete(tenantId);
}

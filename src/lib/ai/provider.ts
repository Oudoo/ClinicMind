import { env } from "@/lib/env";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { EchoProvider } from "./echo";
import type { AiProvider, AiStatus, ProviderConfig } from "./types";
import { AiProviderError } from "./types";

/**
 * Provider registry + routing policy. The choice of adapter lives in one place:
 *
 * - `AI_DEFAULT_PROVIDER=auto` picks the first configured chat provider in the
 *   order gemini → openai → anthropic, falling back to the offline `echo`.
 * - `AI_EMBEDDING_PROVIDER=auto` picks gemini → openai → echo (Anthropic has no
 *   embeddings endpoint).
 * - `AI_TRANSCRIPTION_PROVIDER=auto` picks gemini → openai. There is no silent
 *   fallback for speech-to-text: without a capable provider the result is
 *   `null` and the API says so, because a canned "transcript" of a doctor's
 *   dictation would be a clinical hazard. `echo` transcribes only when named.
 * - An explicit provider name is honoured when that provider is configured.
 *   When it is not, routing falls back to the auto order so a misconfigured
 *   name never silently degrades to `echo` while a real key exists.
 *
 * A tenant may bring its own keys and models (`TenantAiOverrides`, configured
 * in the platform console). Overrides are applied per call and never change
 * the environment-level registry; embeddings stay global because the vector
 * column has one dimension and one model.
 *
 * Every decision is made at call time (not at import), so a test can swap the
 * environment and the registry follows.
 */
export type ProviderName = "gemini" | "openai" | "anthropic" | "echo";
export type VendorName = Exclude<ProviderName, "echo">;

export interface TenantAiOverrides {
  chatProvider?: VendorName;
  transcriptionProvider?: Exclude<VendorName, "anthropic">;
  config?: Partial<Record<VendorName, ProviderConfig>>;
}

const registry: Record<ProviderName, AiProvider> = {
  gemini: new GeminiProvider(),
  openai: new OpenAiProvider(),
  anthropic: new AnthropicProvider(),
  echo: new EchoProvider(),
};

const CHAT_ORDER: ProviderName[] = ["gemini", "openai", "anthropic"];
const EMBED_ORDER: ProviderName[] = ["gemini", "openai"];
const TRANSCRIBE_ORDER: ProviderName[] = ["gemini", "openai"];

function isProviderName(value: string | undefined): value is ProviderName {
  return value === "gemini" || value === "openai" || value === "anthropic" || value === "echo";
}

/** The registry instance, or a per-call instance carrying the tenant's key/model overrides. */
function instance(name: ProviderName, overrides?: TenantAiOverrides): AiProvider {
  const cfg = name === "echo" ? undefined : overrides?.config?.[name];
  if (!cfg || !Object.values(cfg).some((v) => v !== undefined && v !== "")) return registry[name];
  switch (name) {
    case "gemini":
      return new GeminiProvider(cfg);
    case "openai":
      return new OpenAiProvider(cfg);
    case "anthropic":
      return new AnthropicProvider(cfg);
    default:
      return registry.echo;
  }
}

type Capability = "chat" | "embed" | "transcribe";

function usable(p: AiProvider, capability: Capability): boolean {
  if (!p.isConfigured()) return false;
  if (capability === "embed") return p.supportsEmbeddings();
  if (capability === "transcribe") return p.supportsTranscription();
  return true;
}

function resolve(preferred: string | undefined, order: ProviderName[], capability: Capability, overrides?: TenantAiOverrides): AiProvider | null {
  if (isProviderName(preferred)) {
    const candidate = instance(preferred, overrides);
    if (usable(candidate, capability)) return candidate;
  }
  for (const name of order) {
    const candidate = instance(name, overrides);
    if (usable(candidate, capability)) return candidate;
  }
  return null;
}

/** Chat provider: the tenant's choice, else the environment's, else the auto order, else echo. */
export function chatProvider(preferred?: string, overrides?: TenantAiOverrides): AiProvider {
  return resolve(preferred ?? overrides?.chatProvider ?? env.AI_DEFAULT_PROVIDER, CHAT_ORDER, "chat", overrides) ?? registry.echo;
}

/** Embedding provider: explicit when configured and capable, else gemini → openai → echo. Global by design. */
export function embeddingProvider(preferred?: string): AiProvider {
  return resolve(preferred ?? env.AI_EMBEDDING_PROVIDER, EMBED_ORDER, "embed") ?? registry.echo;
}

/**
 * Speech-to-text provider, or `null` when none can transcribe. `echo` is used
 * only when it is named explicitly (tests), never as a fallback.
 */
export function transcriptionProvider(preferred?: string, overrides?: TenantAiOverrides): AiProvider | null {
  const wanted = preferred ?? overrides?.transcriptionProvider ?? env.AI_TRANSCRIPTION_PROVIDER;
  if (wanted === "echo") return registry.echo;
  return resolve(wanted, TRANSCRIBE_ORDER, "transcribe", overrides);
}

/** Snapshot of the active routing for the health endpoint. */
export function aiStatus(): AiStatus {
  const chat = chatProvider();
  const embeddings = embeddingProvider();
  const transcription = transcriptionProvider();
  return {
    chat: { provider: chat.name, model: chat.chatModel(), configured: chat.name !== "echo" },
    embeddings: {
      provider: embeddings.name,
      model: embeddings.embeddingModel() ?? "",
      configured: embeddings.name !== "echo",
    },
    transcription: transcription
      ? { provider: transcription.name, model: transcription.transcriptionModel() ?? "", configured: transcription.name !== "echo" }
      : { provider: "none", model: "", configured: false },
  };
}

export { AiProviderError };
export type { AiProvider, AiStatus };

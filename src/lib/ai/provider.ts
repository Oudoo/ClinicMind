import { env } from "@/lib/env";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { GeminiProvider } from "./gemini";
import { EchoProvider } from "./echo";
import type { AiProvider, AiStatus } from "./types";
import { AiProviderError } from "./types";

/**
 * Provider registry + routing policy. The choice of adapter lives in one place:
 *
 * - `AI_DEFAULT_PROVIDER=auto` picks the first configured chat provider in the
 *   order gemini → openai → anthropic, falling back to the offline `echo`.
 * - `AI_EMBEDDING_PROVIDER=auto` picks gemini → openai → echo (Anthropic has no
 *   embeddings endpoint).
 * - An explicit provider name is honoured when that provider is configured.
 *   When it is not, routing falls back to the auto order so a misconfigured
 *   name never silently degrades to `echo` while a real key exists. `echo` is
 *   always "configured", so naming it explicitly is honoured as well.
 *
 * Every decision is made at call time (not at import), so a test can swap the
 * environment and the registry follows.
 */
type ProviderName = "gemini" | "openai" | "anthropic" | "echo";

const registry: Record<ProviderName, AiProvider> = {
  gemini: new GeminiProvider(),
  openai: new OpenAiProvider(),
  anthropic: new AnthropicProvider(),
  echo: new EchoProvider(),
};

const CHAT_ORDER: ProviderName[] = ["gemini", "openai", "anthropic"];
const EMBED_ORDER: ProviderName[] = ["gemini", "openai"];

function isProviderName(value: string | undefined): value is ProviderName {
  return value === "gemini" || value === "openai" || value === "anthropic" || value === "echo";
}

function resolve(preferred: string | undefined, order: ProviderName[], needsEmbeddings: boolean): AiProvider {
  const usable = (p: AiProvider) => p.isConfigured() && (!needsEmbeddings || p.supportsEmbeddings());
  if (isProviderName(preferred)) {
    const candidate = registry[preferred];
    if (usable(candidate)) return candidate;
  }
  for (const name of order) {
    const candidate = registry[name];
    if (usable(candidate)) return candidate;
  }
  return registry.echo;
}

/** Chat provider: explicit when configured, else the auto order, else echo. */
export function chatProvider(preferred?: string): AiProvider {
  return resolve(preferred ?? env.AI_DEFAULT_PROVIDER, CHAT_ORDER, false);
}

/** Embedding provider: explicit when configured and capable, else gemini → openai → echo. */
export function embeddingProvider(preferred?: string): AiProvider {
  return resolve(preferred ?? env.AI_EMBEDDING_PROVIDER, EMBED_ORDER, true);
}

/** Snapshot of the active routing for the health endpoint. */
export function aiStatus(): AiStatus {
  const chat = chatProvider();
  const embeddings = embeddingProvider();
  return {
    chat: { provider: chat.name, model: chat.chatModel(), configured: chat.name !== "echo" },
    embeddings: {
      provider: embeddings.name,
      model: embeddings.embeddingModel() ?? "",
      configured: embeddings.name !== "echo",
    },
  };
}

export { AiProviderError };
export type { AiProvider, AiStatus };

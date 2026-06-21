import { env } from "@/lib/env";
import { OpenAiProvider } from "./openai";
import { AnthropicProvider } from "./anthropic";
import { EchoProvider } from "./echo";
import type { AiProvider } from "./types";

/**
 * Provider registry + routing. Centralizes the choice of adapter so policy
 * (default provider, embedding routing, graceful offline fallback) lives in one
 * place.
 */
const registry: Record<string, AiProvider> = {
  openai: new OpenAiProvider(),
  anthropic: new AnthropicProvider(),
  echo: new EchoProvider(),
};

/** Chat provider: configured default, else first configured, else echo. */
export function chatProvider(preferred?: string): AiProvider {
  const candidate = registry[preferred ?? env.AI_DEFAULT_PROVIDER];
  if (candidate?.isConfigured()) return candidate;
  const firstLive = Object.values(registry).find((p) => p.name !== "echo" && p.isConfigured());
  return firstLive ?? registry.echo!;
}

/** Embedding provider: only providers that support embeddings (OpenAI), else echo. */
export function embeddingProvider(): AiProvider {
  return registry.openai!.isConfigured() ? registry.openai! : registry.echo!;
}

export type { AiProvider };

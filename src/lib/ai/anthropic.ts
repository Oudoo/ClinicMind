import { env } from "@/lib/env";
import { aiFetchJson } from "./http";
import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedResult } from "./types";
import { AiProviderError } from "./types";

/**
 * Anthropic (Claude) adapter over the Messages REST API. Claude has no
 * first-party embeddings endpoint, so `embed()` is unsupported and the registry
 * routes embeddings to a provider that has one.
 */
const BASE = "https://api.anthropic.com/v1";

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
}

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";

  isConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  supportsEmbeddings(): boolean {
    return false;
  }

  chatModel(): string {
    return env.ANTHROPIC_MODEL;
  }

  embeddingModel(): null {
    return null;
  }

  async chat(messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? this.chatModel();
    const started = Date.now();

    const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
    if (opts.jsonMode) systemParts.push("Respond with a single JSON object and nothing else.");
    const system = systemParts.length ? systemParts.join("\n\n") : undefined;

    const turns = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));

    const json = await aiFetchJson<MessagesResponse>(this.name, `${BASE}/messages`, {
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        ...(system ? { system } : {}),
        messages: turns,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
      },
    });

    const text = (json.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");

    return {
      provider: this.name,
      model,
      content: text,
      latencyMs: Date.now() - started,
      finishReason: json.stop_reason === "end_turn" ? "stop" : json.stop_reason === "max_tokens" ? "length" : "other",
    };
  }

  async embed(): Promise<EmbedResult> {
    throw new AiProviderError(this.name, 0, "anthropic has no embeddings endpoint; route embeddings to gemini or openai");
  }
}

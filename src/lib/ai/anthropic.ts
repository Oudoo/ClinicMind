import { env } from "@/lib/env";
import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedResult } from "./types";

/**
 * Anthropic (Claude) adapter. Demonstrates the provider abstraction: Claude has
 * no first-party embeddings endpoint, so embed() is intentionally unsupported and
 * the registry routes embeddings to a provider that supports them.
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly base = "https://api.anthropic.com/v1";

  isConfigured(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  async chat(messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? "claude-opus-4-8";
    const started = Date.now();
    const system = messages.find((m) => m.role === "system")?.content;
    const turns = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch(`${this.base}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        system,
        messages: turns,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.2,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic chat failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      content: { type: string; text: string }[];
      stop_reason: string;
    };
    const text = json.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    return {
      provider: this.name,
      model,
      content: text,
      latencyMs: Date.now() - started,
      confidence: json.stop_reason === "end_turn" ? 0.9 : 0.6,
    };
  }

  async embed(): Promise<EmbedResult> {
    throw new Error("Anthropic provider does not support embeddings; route to OpenAI.");
  }
}

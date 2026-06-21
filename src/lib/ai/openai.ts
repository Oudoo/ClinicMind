import { env } from "@/lib/env";
import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedResult } from "./types";

/**
 * OpenAI adapter (GPT-4o / GPT-4.1 / Whisper-class via embeddings + chat).
 * Implemented over the REST API directly to avoid a heavy SDK dependency and to
 * keep the adapter swappable.
 */
export class OpenAiProvider implements AiProvider {
  readonly name = "openai";
  private readonly base = "https://api.openai.com/v1";

  isConfigured(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  private headers() {
    return {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    };
  }

  async chat(messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? "gpt-4o";
    const started = Date.now();
    const res = await fetch(`${this.base}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 1024,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI chat failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as {
      choices: { message: { content: string }; finish_reason: string }[];
    };
    const choice = json.choices[0];
    return {
      provider: this.name,
      model,
      content: choice?.message.content ?? "",
      latencyMs: Date.now() - started,
      confidence: choice?.finish_reason === "stop" ? 0.9 : 0.6,
    };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const model = "text-embedding-3-small";
    const res = await fetch(`${this.base}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embed failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return { provider: this.name, model, vectors: json.data.map((d) => d.embedding) };
  }
}

import { env } from "@/lib/env";
import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedResult } from "./types";

/**
 * Google Gemini adapter (gemini-1.5-flash / 1.5-pro / 2.0-flash).
 *
 * Implemented over the Generative Language REST API. Chat is fully supported.
 *
 * Embeddings: Gemini's text-embedding-004 produces 768-dim vectors, while the
 * RAG store column is vector(1536) (OpenAI text-embedding-3-small). To avoid a
 * silent dimension mismatch we do NOT serve embeddings here; the registry routes
 * embeddings to a compatible provider (OpenAI) or the offline echo fallback. To
 * use Gemini for retrieval, add a 768-dim column + index and switch
 * embeddingProvider() — see docs/ARCHITECTURE.md.
 */
export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  private readonly base = "https://generativelanguage.googleapis.com/v1beta";

  isConfigured(): boolean {
    return Boolean(env.GEMINI_API_KEY);
  }

  async chat(messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? "gemini-1.5-flash";
    const started = Date.now();

    const system = messages.find((m) => m.role === "system")?.content;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const res = await fetch(
      `${this.base}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            temperature: opts.temperature ?? 0.2,
            maxOutputTokens: opts.maxTokens ?? 1024,
            ...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`Gemini chat failed: ${res.status} ${await res.text()}`);
    }

    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    };
    const candidate = json.candidates?.[0];
    const content = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    return {
      provider: this.name,
      model,
      content,
      latencyMs: Date.now() - started,
      confidence: candidate?.finishReason === "STOP" ? 0.9 : 0.6,
    };
  }

  async embed(): Promise<EmbedResult> {
    throw new Error(
      "Gemini embeddings are 768-dim and incompatible with the vector(1536) store; route to OpenAI.",
    );
  }
}

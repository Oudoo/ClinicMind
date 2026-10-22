import { env } from "@/lib/env";
import { aiFetchJson } from "./http";
import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedOptions, EmbedResult } from "./types";
import { AiProviderError, EMBEDDING_DIMENSIONS } from "./types";
import { batched, normalizeVector } from "./vectors";

/**
 * Google Gemini adapter over the Generative Language REST API.
 *
 * - The API key travels in the `x-goog-api-key` header, never in the URL (URLs
 *   end up in proxy and access logs).
 * - Chat uses `generateContent` on `GEMINI_MODEL`.
 * - Embeddings use `batchEmbedContents` on `GEMINI_EMBEDDING_MODEL` with
 *   `outputDimensionality: 1536` to fit the `vector(1536)` column and a task
 *   type of RETRIEVAL_DOCUMENT / RETRIEVAL_QUERY. Truncated Gemini embeddings
 *   are not unit length, so they are L2-normalised before use.
 */
const BASE = "https://generativelanguage.googleapis.com/v1beta";
/** batchEmbedContents accepts at most 100 requests per call. */
const EMBED_BATCH = 100;

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

interface BatchEmbedResponse {
  embeddings?: { values?: number[] }[];
}

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";

  isConfigured(): boolean {
    return Boolean(env.GEMINI_API_KEY);
  }

  supportsEmbeddings(): boolean {
    return true;
  }

  chatModel(): string {
    return env.GEMINI_MODEL;
  }

  embeddingModel(): string {
    return env.GEMINI_EMBEDDING_MODEL;
  }

  private headers(): Record<string, string> {
    return { "x-goog-api-key": env.GEMINI_API_KEY ?? "" };
  }

  async chat(messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? this.chatModel();
    const started = Date.now();

    const system = messages.find((m) => m.role === "system")?.content;
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));

    const json = await aiFetchJson<GenerateContentResponse>(
      this.name,
      `${BASE}/models/${encodeURIComponent(model)}:generateContent`,
      {
        headers: this.headers(),
        body: {
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            temperature: opts.temperature ?? 0.2,
            maxOutputTokens: opts.maxTokens ?? 1024,
            ...(opts.jsonMode ? { responseMimeType: "application/json" } : {}),
          },
        },
      },
    );

    const candidate = json.candidates?.[0];
    if (!candidate && json.promptFeedback?.blockReason) {
      throw new AiProviderError(this.name, 200, `gemini blocked the request (${json.promptFeedback.blockReason})`);
    }
    const content = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    return {
      provider: this.name,
      model,
      content,
      latencyMs: Date.now() - started,
      finishReason: candidate?.finishReason === "STOP" ? "stop" : candidate?.finishReason === "MAX_TOKENS" ? "length" : "other",
    };
  }

  async embed(texts: string[], opts: EmbedOptions = {}): Promise<EmbedResult> {
    const model = this.embeddingModel();
    const qualified = model.startsWith("models/") ? model : `models/${model}`;
    const taskType = opts.kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
    const vectors: number[][] = [];

    for (const batch of batched(texts, EMBED_BATCH)) {
      const json = await aiFetchJson<BatchEmbedResponse>(this.name, `${BASE}/${qualified}:batchEmbedContents`, {
        headers: this.headers(),
        body: {
          requests: batch.map((text) => ({
            model: qualified,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        },
      });
      const embeddings = json.embeddings ?? [];
      if (embeddings.length !== batch.length) {
        throw new AiProviderError(this.name, 200, `gemini returned ${embeddings.length} embeddings for ${batch.length} inputs`);
      }
      for (const e of embeddings) {
        const values = e.values ?? [];
        if (values.length !== EMBEDDING_DIMENSIONS) {
          throw new AiProviderError(this.name, 200, `gemini embedding has ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
        }
        vectors.push(normalizeVector(values));
      }
    }

    return { provider: this.name, model, vectors };
  }
}

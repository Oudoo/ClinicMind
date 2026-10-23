import { env } from "@/lib/env";
import { aiFetchForm, aiFetchJson } from "./http";
import type {
  AiMessage,
  AiProvider,
  ChatOptions,
  ChatResult,
  EmbedOptions,
  EmbedResult,
  ProviderConfig,
  TranscribeOptions,
  TranscribeResult,
} from "./types";
import { AiProviderError, EMBEDDING_DIMENSIONS } from "./types";
import { batched, normalizeVector } from "./vectors";
import { audioExtension, transcriptionPrompt } from "./transcription";

/**
 * OpenAI adapter over the REST API (no SDK dependency, swappable).
 * Chat on `OPENAI_MODEL`; embeddings on `OPENAI_EMBEDDING_MODEL` requested at
 * 1536 dimensions to match the store; speech-to-text on
 * `OPENAI_TRANSCRIPTION_MODEL` through the audio transcriptions endpoint.
 */
const BASE = "https://api.openai.com/v1";
/** Keep embedding requests comfortably inside the per-request token budget. */
const EMBED_BATCH = 64;

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
}

interface EmbeddingsResponse {
  data?: { embedding?: number[]; index?: number }[];
}

interface TranscriptionResponse {
  text?: string;
}

export class OpenAiProvider implements AiProvider {
  readonly name = "openai";

  constructor(private readonly cfg: ProviderConfig = {}) {}

  private apiKey(): string | undefined {
    return this.cfg.apiKey ?? env.OPENAI_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  supportsEmbeddings(): boolean {
    return true;
  }

  supportsTranscription(): boolean {
    return true;
  }

  chatModel(): string {
    return this.cfg.chatModel ?? env.OPENAI_MODEL;
  }

  embeddingModel(): string {
    return this.cfg.embeddingModel ?? env.OPENAI_EMBEDDING_MODEL;
  }

  transcriptionModel(): string {
    return this.cfg.transcriptionModel ?? env.OPENAI_TRANSCRIPTION_MODEL;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey() ?? ""}` };
  }

  async transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscribeResult> {
    const model = opts.model ?? this.transcriptionModel();
    const started = Date.now();
    const form = new FormData();
    form.append("file", new Blob([audio.slice()], { type: opts.mimeType }), `dictation.${audioExtension(opts.mimeType)}`);
    form.append("model", model);
    form.append("response_format", "json");
    form.append("prompt", transcriptionPrompt(opts));
    if (opts.language && opts.language !== "auto") form.append("language", opts.language);
    const json = await aiFetchForm<TranscriptionResponse>(this.name, `${BASE}/audio/transcriptions`, {
      headers: this.headers(),
      form,
    });
    return { provider: this.name, model, text: (json.text ?? "").trim(), latencyMs: Date.now() - started };
  }

  async chat(messages: AiMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = opts.model ?? this.chatModel();
    const started = Date.now();

    const json = await aiFetchJson<ChatCompletionResponse>(this.name, `${BASE}/chat/completions`, {
      headers: this.headers(),
      body: {
        model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_completion_tokens: opts.maxTokens ?? 1024,
        ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
      },
    });

    const choice = json.choices?.[0];
    return {
      provider: this.name,
      model,
      content: choice?.message?.content ?? "",
      latencyMs: Date.now() - started,
      finishReason: choice?.finish_reason === "stop" ? "stop" : choice?.finish_reason === "length" ? "length" : "other",
    };
  }

  async embed(texts: string[], _opts: EmbedOptions = {}): Promise<EmbedResult> {
    const model = this.embeddingModel();
    const vectors: number[][] = [];

    for (const batch of batched(texts, EMBED_BATCH)) {
      const json = await aiFetchJson<EmbeddingsResponse>(this.name, `${BASE}/embeddings`, {
        headers: this.headers(),
        body: { model, input: batch, dimensions: EMBEDDING_DIMENSIONS },
      });
      const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      if (data.length !== batch.length) {
        throw new AiProviderError(this.name, 200, `openai returned ${data.length} embeddings for ${batch.length} inputs`);
      }
      for (const d of data) {
        const values = d.embedding ?? [];
        if (values.length !== EMBEDDING_DIMENSIONS) {
          throw new AiProviderError(this.name, 200, `openai embedding has ${values.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
        }
        vectors.push(normalizeVector(values));
      }
    }

    return { provider: this.name, model, vectors };
  }
}

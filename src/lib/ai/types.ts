/**
 * Provider-agnostic AI contract.
 *
 * The rest of ClinicMind depends only on these interfaces, never on a specific
 * vendor SDK. Swapping or adding a provider (OpenAI, Anthropic, Gemini, an
 * on-prem open model) is a matter of registering a new adapter — no call-site
 * changes.
 */

export type AiRole = "system" | "user" | "assistant";

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface ChatOptions {
  /** Override the model configured in the environment for this call only. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a JSON object (structured extraction). */
  jsonMode?: boolean;
}

export interface ChatResult {
  provider: string;
  model: string;
  content: string;
  latencyMs: number;
  /** Why generation ended; a truncated answer is treated with less trust. */
  finishReason: "stop" | "length" | "other";
}

/**
 * Embedding task type. Retrieval models (Gemini in particular) embed documents
 * and queries into slightly different spaces; passing the right kind improves
 * ranking. Providers without the distinction ignore it.
 */
export type EmbedKind = "document" | "query";

export interface EmbedOptions {
  kind?: EmbedKind;
}

export interface EmbedResult {
  provider: string;
  model: string;
  /** One unit-length (L2-normalised) 1536-dim vector per input text. */
  vectors: number[][];
}

/** Dimension of the `knowledge_embeddings.embedding` column. */
export const EMBEDDING_DIMENSIONS = 1536;

export interface AiProvider {
  readonly name: string;
  /** True when the provider has credentials and can serve live traffic. */
  isConfigured(): boolean;
  /** Whether `embed()` is implemented (Anthropic has no embeddings endpoint). */
  supportsEmbeddings(): boolean;
  /** Model ids this adapter will use, resolved from the environment. */
  chatModel(): string;
  embeddingModel(): string | null;
  chat(messages: AiMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed(texts: string[], opts?: EmbedOptions): Promise<EmbedResult>;
}

/**
 * Typed failure of an upstream AI call. `status` is the HTTP status the
 * provider answered with, or 0 when the request never completed (timeout,
 * network). The message never contains the request body or any prompt text.
 */
export class AiProviderError extends Error {
  readonly provider: string;
  readonly status: number;

  constructor(provider: string, status: number, message: string) {
    super(message);
    this.name = "AiProviderError";
    this.provider = provider;
    this.status = status;
  }
}

/** Snapshot of the active routing, for the health endpoint. */
export interface AiStatus {
  chat: { provider: string; model: string; configured: boolean };
  embeddings: { provider: string; model: string; configured: boolean };
}

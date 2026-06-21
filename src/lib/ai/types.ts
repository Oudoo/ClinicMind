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
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** JSON schema name hint when structured output is required. */
  jsonMode?: boolean;
}

export interface ChatResult {
  provider: string;
  model: string;
  content: string;
  latencyMs: number;
  /** Heuristic confidence in [0,1] used for the "never answer blindly" guardrail. */
  confidence?: number;
}

export interface EmbedResult {
  provider: string;
  model: string;
  vectors: number[][];
}

export interface AiProvider {
  readonly name: string;
  /** True when the provider has credentials and can serve live traffic. */
  isConfigured(): boolean;
  chat(messages: AiMessage[], opts?: ChatOptions): Promise<ChatResult>;
  embed(texts: string[]): Promise<EmbedResult>;
}

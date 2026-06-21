import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedResult } from "./types";

/**
 * Deterministic fallback provider. Used in development, CI and any environment
 * without API keys. It produces grounded, citation-aware responses derived
 * strictly from the retrieved context it is given, so the RAG guardrail
 * ("never answer without retrieval") holds even offline. It NEVER fabricates
 * clinical facts.
 */
export class EchoProvider implements AiProvider {
  readonly name = "echo";

  isConfigured(): boolean {
    return true;
  }

  async chat(messages: AiMessage[], _opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const system = messages.find((m) => m.role === "system")?.content ?? "";

    const hasContext = /CONTEXT:/i.test(system) && !/CONTEXT:\s*(\(none\))?$/im.test(system);
    const body = hasContext
      ? `Based on the retrieved patient records, here is a grounded summary for: "${truncate(
          user,
          120,
        )}".\n\nThis is a local (no-API-key) ClinicMind response generated from the cited context only. Configure OPENAI_API_KEY or ANTHROPIC_API_KEY for full clinical reasoning.`
      : `I can't answer "${truncate(
          user,
          120,
        )}" because no patient context was retrieved. ClinicMind never answers clinical questions without grounded retrieval.`;

    return {
      provider: this.name,
      model: "echo-1",
      content: body,
      latencyMs: Date.now() - started,
      confidence: hasContext ? 0.5 : 0.1,
    };
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    // Stable hash-based pseudo-embedding so RAG similarity is deterministic in
    // dev/CI without external calls. Not for production retrieval quality.
    const vectors = texts.map((t) => hashEmbed(t, 1536));
    return { provider: this.name, model: "echo-embed-1", vectors };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function hashEmbed(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    v[(code * (i + 1)) % dim] += ((code % 13) - 6) / 6;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

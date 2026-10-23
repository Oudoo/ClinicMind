import type { AiMessage, AiProvider, ChatOptions, ChatResult, EmbedOptions, EmbedResult, TranscribeOptions, TranscribeResult } from "./types";
import { EMBEDDING_DIMENSIONS } from "./types";

/**
 * Deterministic offline provider. Used in development, CI and any environment
 * without API keys.
 *
 * Chat: it never reasons and never invents — it summarises the retrieved
 * context it is given, listing the facts from the records with their `[n]`
 * citation markers so a key-less demo still shows real patient data. Without
 * context it says so plainly.
 *
 * Embeddings: a stable character-hash pseudo-embedding so retrieval is
 * deterministic without external calls. It has no semantic meaning; the hybrid
 * lexical pass in `rag.ts` is what makes offline retrieval usable.
 */
export class EchoProvider implements AiProvider {
  readonly name = "echo";

  isConfigured(): boolean {
    return true;
  }

  supportsEmbeddings(): boolean {
    return true;
  }

  /** Only when named explicitly (`AI_TRANSCRIPTION_PROVIDER=echo`, tests): it recognises no speech. */
  supportsTranscription(): boolean {
    return true;
  }

  chatModel(): string {
    return "echo-1";
  }

  embeddingModel(): string {
    return "echo-embed-1";
  }

  transcriptionModel(): string {
    return "echo-transcribe-1";
  }

  async transcribe(audio: Uint8Array, opts: TranscribeOptions): Promise<TranscribeResult> {
    const kb = Math.max(1, Math.round(audio.byteLength / 1024));
    const text = `${opts.speakers ? "Doctor: " : ""}[offline transcription] ${kb} KB of ${opts.mimeType} audio received. No speech-to-text provider is configured, so the words were not recognised; type or paste the transcript instead.`;
    return { provider: this.name, model: this.transcriptionModel(), text, latencyMs: 0 };
  }

  async chat(messages: AiMessage[], _opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const user = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const items = parseContextItems(system);

    const content = items.length ? groundedSummary(user, items) : noRecordsMessage(user);

    return {
      provider: this.name,
      model: this.chatModel(),
      content,
      latencyMs: Date.now() - started,
      finishReason: "stop",
    };
  }

  async embed(texts: string[], _opts: EmbedOptions = {}): Promise<EmbedResult> {
    const vectors = texts.map((t) => hashEmbed(t, EMBEDDING_DIMENSIONS));
    return { provider: this.name, model: this.embeddingModel(), vectors };
  }
}

export interface ContextItem {
  index: number;
  /** First line after the marker: `SOURCE · title · patient · date`. */
  heading: string;
  /** Remaining lines of the chunk. */
  lines: string[];
}

/**
 * Parse the `CONTEXT:` block produced by `rag.ts`. Items start with a `[n]`
 * marker at the beginning of a line and run until the next marker. Returns an
 * empty list when the block is absent or `(none)`.
 */
export function parseContextItems(system: string): ContextItem[] {
  const at = system.search(/^CONTEXT:/m);
  if (at === -1) return [];
  const block = system.slice(at + "CONTEXT:".length);
  const items: ContextItem[] = [];
  const re = /^\[(\d+)\][ \t]*(.*)$/gm;
  const markers: { index: number; heading: string; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    markers.push({ index: Number(m[1]), heading: (m[2] ?? "").trim(), start: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]!;
    const end = markers[i + 1]?.start ?? block.length;
    const lines = block
      .slice(marker.bodyStart, end)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    items.push({ index: marker.index, heading: marker.heading, lines });
  }
  return items;
}

/**
 * A short, honest summary: for each of the best-matching records, the lines
 * most relevant to the question (by term overlap), each tagged with its `[n]`.
 */
function groundedSummary(query: string, items: ContextItem[]): string {
  const terms = queryTerms(query);
  const ranked = items
    .map((item) => ({ item, relevance: overlapScore(terms, [item.heading, ...item.lines].join(" ")) }))
    .sort((a, b) => b.relevance - a.relevance || a.item.index - b.item.index)
    .slice(0, 4);

  const bullets = ranked.map(({ item }) => {
    const facts = pickFacts(item.lines, terms, 3);
    const label = item.heading ? `${item.heading}: ` : "";
    return `• ${label}${facts.join("; ")} [${item.index}]`;
  });

  return [
    `Grounded summary for "${truncate(query, 120)}" from ${items.length} matching record${items.length === 1 ? "" : "s"}:`,
    "",
    ...bullets,
    "",
    "Offline mode (no AI provider key configured): the facts above are quoted from the cited records without further clinical reasoning. Verify against the chart before acting.",
  ].join("\n");
}

function noRecordsMessage(query: string): string {
  return `No matching records were found for "${truncate(
    query,
    120,
  )}". The clinic's indexed records do not contain information that answers this question, and ClinicMind does not answer clinical questions without matching records.`;
}

/** Lines ranked by overlap with the question; ties keep document order. */
function pickFacts(lines: string[], terms: Set<string>, max: number): string[] {
  if (!lines.length) return ["(no details)"];
  const scored = lines.map((line, i) => ({ line, i, score: overlapScore(terms, line) }));
  const chosen = [...scored]
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i);
  return chosen.map((c) => truncate(c.line, 160));
}

function queryTerms(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

function overlapScore(terms: Set<string>, text: string): number {
  if (!terms.size) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  terms.forEach((t) => {
    if (lower.includes(t)) hits += 1;
  });
  return hits / terms.size;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Stable hash-based pseudo-embedding, unit length. Not for production retrieval quality. */
export function hashEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    v[(code * (i + 1)) % dim]! += ((code % 13) - 6) / 6;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

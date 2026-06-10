import { env } from "../env.js";
import { openai, recordAiCost, type AiCallContext } from "./provider.js";

/**
 * Embedding generation for the AOM semantic search layer (pgvector,
 * 1536 dimensions). OpenAI text-embedding-3-small by default.
 */
export async function embedTexts(
  texts: string[],
  ctx: AiCallContext
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = env.embeddingModel;
  const res = await openai().embeddings.create({
    model,
    input: texts,
    dimensions: 1536,
  });
  await recordAiCost(
    { ...ctx, feature: ctx.feature || "embedding" },
    "openai",
    model,
    res.usage?.prompt_tokens ?? 0,
    0
  );
  return res.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** Chunk long text into ~1200-char overlapping windows for embedding. */
export function chunkText(text: string, chunkSize = 1200, overlap = 150): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= chunkSize) return clean ? [clean] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    // Break on sentence boundary when possible
    if (end < clean.length) {
      const lastPeriod = clean.lastIndexOf(". ", end);
      if (lastPeriod > start + chunkSize / 2) end = lastPeriod + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = end - overlap;
  }
  return chunks;
}

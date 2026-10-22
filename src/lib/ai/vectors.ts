/**
 * Small vector helpers shared by the adapters and the RAG layer.
 *
 * The store compares vectors with cosine distance, so every stored and every
 * query vector must be unit length. OpenAI returns normalised embeddings;
 * Gemini's `outputDimensionality`-truncated embeddings are NOT normalised and
 * the offline hash embedding is normalised explicitly. Normalising everything
 * once, here, keeps the similarity scale identical across providers.
 */

/** L2-normalise in place-safe fashion (returns a new array). A zero vector is returned unchanged. */
export function normalizeVector(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const x of vector) sumOfSquares += x * x;
  const norm = Math.sqrt(sumOfSquares);
  if (!Number.isFinite(norm) || norm === 0) return [...vector];
  return vector.map((x) => x / norm);
}

export function vectorNorm(vector: number[]): number {
  let sumOfSquares = 0;
  for (const x of vector) sumOfSquares += x * x;
  return Math.sqrt(sumOfSquares);
}

/** pgvector text literal: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((x) => (Number.isFinite(x) ? x.toString() : "0")).join(",")}]`;
}

/** Split a list into batches of at most `size` items (provider request limits). */
export function batched<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { chatProvider, embeddingProvider } from "./provider";
import type { AiMessage } from "./types";

/**
 * Retrieval-Augmented Generation pipeline for the Doctor AI Chat.
 *
 * Hard rule: the assistant NEVER answers without retrieval. Every answer is
 * grounded in tenant-scoped patient knowledge and returns citations.
 *
 * Pipeline:  embed query -> vector retrieve (pgvector) -> rank -> re-rank ->
 *            generate with citations.
 */

export interface RetrievedChunk {
  id: string;
  source: string;
  refId: string;
  content: string;
  score: number; // cosine similarity in [0,1]
}

export interface Citation {
  index: number;
  source: string;
  refId: string;
  snippet: string;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  chunks: RetrievedChunk[];
  provider: string;
  model: string;
  confidence: number;
  latencyMs: number;
}

/** Step 1–2: embed the query and retrieve nearest neighbours within the tenant. */
export async function retrieve(
  tenantId: string,
  query: string,
  topK = 8,
): Promise<RetrievedChunk[]> {
  const { vectors } = await embeddingProvider().embed([query]);
  const queryVec = vectors[0];
  if (!queryVec) return [];

  // pgvector cosine distance (<=>). Score = 1 - distance. Tenant-scoped.
  const literal = `[${queryVec.join(",")}]`;
  const rows = await db.$queryRaw<
    { id: string; source: string; refId: string; content: string; distance: number }[]
  >(Prisma.sql`
    SELECT id, source, "refId", content,
           (embedding <=> ${literal}::vector) AS distance
    FROM knowledge_embeddings
    WHERE "tenantId" = ${tenantId} AND embedding IS NOT NULL
    ORDER BY embedding <=> ${literal}::vector
    LIMIT ${topK}
  `);

  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    refId: r.refId,
    content: r.content,
    score: 1 - r.distance,
  }));
}

/**
 * Step 3–4: rank by similarity then lightweight lexical re-rank (boost chunks
 * sharing salient query terms). Keeps the top results that actually overlap the
 * question, mitigating pure-vector drift.
 */
export function rerank(query: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  const terms = new Set(
    query
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
  return [...chunks]
    .map((c) => {
      const text = c.content.toLowerCase();
      let overlap = 0;
      terms.forEach((t) => {
        if (text.includes(t)) overlap += 1;
      });
      const lexical = terms.size ? overlap / terms.size : 0;
      return { ...c, score: c.score * 0.75 + lexical * 0.25 };
    })
    .sort((a, b) => b.score - a.score);
}

/** Step 5: generate a grounded, cited answer. */
export async function answerWithRag(
  tenantId: string,
  query: string,
  opts: { topK?: number; preferProvider?: string } = {},
): Promise<RagAnswer> {
  const started = Date.now();
  const retrieved = rerank(query, await retrieve(tenantId, query, opts.topK ?? 8)).slice(0, 6);

  const citations: Citation[] = retrieved.map((c, i) => ({
    index: i + 1,
    source: c.source,
    refId: c.refId,
    snippet: c.content.slice(0, 240),
  }));

  const contextBlock = retrieved.length
    ? retrieved.map((c, i) => `[${i + 1}] (${c.source}) ${c.content}`).join("\n")
    : "(none)";

  const system: AiMessage = {
    role: "system",
    content: [
      "You are ClinicMind's clinical assistant for a licensed physician.",
      "Answer ONLY from the CONTEXT below. If the context is insufficient, say so plainly.",
      "Cite every claim using [n] markers that match the context items.",
      "Never invent diagnoses, medications, or values not present in the context.",
      "",
      `CONTEXT:\n${contextBlock}`,
    ].join("\n"),
  };

  const provider = chatProvider(opts.preferProvider);
  const result = await provider.chat([system, { role: "user", content: query }], {
    temperature: 0.1,
  });

  return {
    answer: result.content,
    citations,
    chunks: retrieved,
    provider: result.provider,
    model: result.model,
    confidence: retrieved.length ? (result.confidence ?? 0.7) : 0.1,
    latencyMs: Date.now() - started,
  };
}

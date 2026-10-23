import { db, notDeleted } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { chatProvider, embeddingProvider, type TenantAiOverrides } from "./provider";
import type { AiMessage } from "./types";
import { toVectorLiteral } from "./vectors";

/**
 * Retrieval-Augmented Generation for the Doctor AI Chat.
 *
 * Hard rule: the assistant NEVER answers without retrieval. Every answer is
 * grounded in tenant-scoped patient knowledge and returns citations.
 *
 * Pipeline:
 *   embed query ─► vector search (pgvector cosine, tenant-scoped)
 *                ─► lexical search (pg_trgm word similarity / ILIKE on content,
 *                    which catches exact names and drug names that embeddings
 *                    blur) ─► merge + de-duplicate ─► lexical re-rank
 *                ─► grounded generation with [n] citations
 *                ─► confidence from retrieval quality + citation use.
 */

/** Provenance stored on every chunk by the ingestion module. */
export interface ChunkMetadata {
  title: string;
  occurredAt: string | null;
  kind: "patient_history" | "patient_medications" | "visit" | "consultation" | "conversation";
  /** Embedding model the vector was produced with; a model change forces re-embedding. */
  model: string;
  provider?: string;
  patientName?: string | null;
  chunkCount?: number;
}

export interface RetrievedChunk {
  id: string;
  source: string;
  refId: string;
  patientId: string | null;
  chunkIndex: number;
  content: string;
  metadata: ChunkMetadata | null;
  /** Combined relevance in [0,1]. */
  score: number;
  /** Cosine similarity of the embedding, clamped to [0,1]; 0 when only the lexical pass hit. */
  vectorScore: number;
  /** pg_trgm word similarity of the best query term, in [0,1]; 0 when only the vector pass hit. */
  lexicalScore: number;
}

export interface Citation {
  index: number;
  source: string;
  refId: string;
  patientId: string | null;
  patientName: string | null;
  title: string;
  snippet: string;
  /** Link to the patient's record when the chunk is about a known patient. */
  href: string | null;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  chunks: RetrievedChunk[];
  provider: string;
  model: string;
  confidence: number;
  grounded: boolean;
  latencyMs: number;
}

export interface RetrieveOptions {
  topK?: number;
  /** Restrict retrieval to one patient's records (the UI's patient-context picker). */
  patientId?: string | null;
}

/** Below this combined score a chunk does not count as a "strong" match. */
export const STRONG_MATCH_THRESHOLD = 0.4;
/** Minimum confidence for an answer to be presented as grounded. */
export const GROUNDED_THRESHOLD = 0.35;
/**
 * Chunks scoring below this never reach the prompt. The vector pass always
 * returns the nearest neighbours, however distant; without a floor an
 * unrelated question would be "answered" from unrelated records.
 */
export const CONTEXT_SCORE_FLOOR = 0.2;

const VECTOR_WEIGHT = 0.6;
const LEXICAL_WEIGHT = 0.4;
/** Minimum pg_trgm word similarity for a fuzzy (typo-tolerant) lexical hit. */
const FUZZY_THRESHOLD = 0.5;
/** ivfflat probes for the vector search; the index has 100 lists. */
const IVFFLAT_PROBES = 10;

interface VectorRow {
  id: string;
  source: string;
  refId: string;
  patientId: string | null;
  chunkIndex: number;
  content: string;
  metadata: unknown;
  distance: number;
}

interface LexicalRow {
  id: string;
  source: string;
  refId: string;
  patientId: string | null;
  chunkIndex: number;
  content: string;
  metadata: unknown;
  lexical: number;
}

/**
 * Step 1–3: hybrid retrieval within the tenant, optionally within one patient.
 * Results are merged, de-duplicated and re-ranked; scores are in [0,1].
 */
export async function retrieve(tenantId: string, query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
  const topK = Math.max(1, Math.min(opts.topK ?? 8, 50));
  const patientId = opts.patientId ?? null;
  const terms = extractLexicalTerms(query);

  const [vectorRows, lexicalRows] = await Promise.all([
    vectorSearch(tenantId, query, patientId, topK * 2),
    terms.length ? lexicalSearch(tenantId, terms, patientId, topK * 2) : Promise.resolve([] as LexicalRow[]),
  ]);

  const merged = new Map<string, RetrievedChunk>();
  for (const r of vectorRows) {
    merged.set(r.id, {
      id: r.id,
      source: r.source,
      refId: r.refId,
      patientId: r.patientId,
      chunkIndex: r.chunkIndex,
      content: r.content,
      metadata: parseMetadata(r.metadata),
      vectorScore: clamp01(1 - r.distance),
      lexicalScore: 0,
      score: 0,
    });
  }
  for (const r of lexicalRows) {
    const existing = merged.get(r.id);
    if (existing) {
      existing.lexicalScore = clamp01(r.lexical);
    } else {
      merged.set(r.id, {
        id: r.id,
        source: r.source,
        refId: r.refId,
        patientId: r.patientId,
        chunkIndex: r.chunkIndex,
        content: r.content,
        metadata: parseMetadata(r.metadata),
        vectorScore: 0,
        lexicalScore: clamp01(r.lexical),
        score: 0,
      });
    }
  }

  const combined = [...merged.values()].map((c) => ({
    ...c,
    score: clamp01(VECTOR_WEIGHT * c.vectorScore + LEXICAL_WEIGHT * c.lexicalScore),
  }));

  return rerank(query, combined).slice(0, topK);
}

async function vectorSearch(tenantId: string, query: string, patientId: string | null, limit: number): Promise<VectorRow[]> {
  const { vectors } = await embeddingProvider().embed([query], { kind: "query" });
  const queryVec = vectors[0];
  if (!queryVec) return [];
  const literal = toVectorLiteral(queryVec);
  const patientFilter = patientId ? Prisma.sql`AND "patientId" = ${patientId}` : Prisma.empty;

  // pgvector cosine distance (<=>); score = 1 - distance. Tenant-scoped. The
  // probe count is raised for this transaction only so the ivfflat index (100
  // lists) keeps good recall on large tenants.
  const [, rows] = await db.$transaction([
    db.$executeRaw`SET LOCAL ivfflat.probes = ${Prisma.raw(String(IVFFLAT_PROBES))}`,
    db.$queryRaw<VectorRow[]>(Prisma.sql`
      SELECT id, source::text AS source, "refId", "patientId", "chunkIndex", content, metadata,
             (embedding <=> ${literal}::vector) AS distance
      FROM knowledge_embeddings
      WHERE "tenantId" = ${tenantId} AND embedding IS NOT NULL ${patientFilter}
      ORDER BY embedding <=> ${literal}::vector
      LIMIT ${limit}
    `),
  ]);
  return rows;
}

async function lexicalSearch(tenantId: string, terms: string[], patientId: string | null, limit: number): Promise<LexicalRow[]> {
  const patientFilter = patientId ? Prisma.sql`AND "patientId" = ${patientId}` : Prisma.empty;
  // Exact substring (ILIKE) catches names and drug names verbatim; pg_trgm
  // word_similarity adds typo tolerance ("amlodipin") and provides the score.
  const similarity = Prisma.sql`GREATEST(${Prisma.join(
    terms.map((t) => Prisma.sql`word_similarity(${t}, content)`),
    ", ",
  )})`;
  const matches = Prisma.join(
    terms.map((t) => Prisma.sql`content ILIKE ${`%${escapeLike(t)}%`} OR word_similarity(${t}, content) >= ${FUZZY_THRESHOLD}`),
    " OR ",
  );
  return db.$queryRaw<LexicalRow[]>(Prisma.sql`
    SELECT id, source::text AS source, "refId", "patientId", "chunkIndex", content, metadata,
           ${similarity} AS lexical
    FROM knowledge_embeddings
    WHERE "tenantId" = ${tenantId} ${patientFilter}
      AND (${matches})
    ORDER BY lexical DESC, "updatedAt" DESC
    LIMIT ${limit}
  `);
}

/**
 * Step 4: lightweight lexical re-rank — boost chunks sharing salient query
 * terms so pure-vector drift does not outrank an exact mention.
 */
export function rerank<T extends { content: string; score: number }>(query: string, chunks: T[]): T[] {
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

/**
 * Honest confidence from what retrieval actually found and whether the answer
 * used it: the best match, how many chunks were strong matches, and whether
 * the answer carries `[n]` citation markers. No chunks → 0.
 */
export function computeConfidence(input: { chunks: { score: number }[]; answer: string }): number {
  if (!input.chunks.length) return 0;
  const top = Math.max(...input.chunks.map((c) => clamp01(c.score)));
  const strong = input.chunks.filter((c) => c.score >= STRONG_MATCH_THRESHOLD).length;
  const cited = /\[\d+\]/.test(input.answer) ? 1 : 0;
  return round3(clamp01(0.5 * top + 0.3 * (Math.min(strong, 3) / 3) + 0.2 * cited));
}

/** Step 5: generate a grounded, cited answer. */
export async function answerWithRag(
  tenantId: string,
  query: string,
  opts: { topK?: number; patientId?: string | null; preferProvider?: string; tenantAi?: TenantAiOverrides } = {},
): Promise<RagAnswer> {
  const started = Date.now();
  const retrieved = (await retrieve(tenantId, query, { topK: opts.topK ?? 8, patientId: opts.patientId }))
    .filter((c) => c.score >= CONTEXT_SCORE_FLOOR)
    .slice(0, 6);
  const names = await patientNames(tenantId, retrieved);

  // Gate before generation: when even a fully cited answer could not reach the
  // grounded threshold, the records do not answer the question. Say so instead
  // of asking a model to summarise near-misses, which reads like an answer.
  const ceiling = computeConfidence({ chunks: retrieved, answer: "[1]" });
  if (!retrieved.length || ceiling < GROUNDED_THRESHOLD) {
    return {
      answer: noMatchingRecordsAnswer(query),
      citations: [],
      chunks: retrieved,
      provider: "clinicmind",
      model: "retrieval-gate",
      confidence: computeConfidence({ chunks: retrieved, answer: "" }),
      grounded: false,
      latencyMs: Date.now() - started,
    };
  }

  const contextBlock = retrieved.length
    ? retrieved.map((c, i) => `[${i + 1}] ${headingFor(c, names)}\n${c.content}`).join("\n\n")
    : "(none)";

  const system: AiMessage = {
    role: "system",
    content: [
      "You are ClinicMind's clinical assistant. You provide decision support to licensed clinic staff; you do not give medical advice to patients.",
      "Answer ONLY from the CONTEXT below, which is retrieved from this clinic's own patient records.",
      "Cite every statement of fact with the [n] marker of the context item it comes from; a statement without a marker is not allowed.",
      "Never invent or infer diagnoses, medications, doses, dates, lab values or outcomes that are not written in the context. Do not generalise from one patient to another.",
      "If the context does not contain the answer, or only partly answers, say so plainly (for example: \"The records do not contain …\") instead of guessing.",
      "Be concise and clinical. Keep patient names exactly as they appear in the context. Answer in the language of the question.",
      opts.patientId ? "The question is about a single patient; the context is restricted to that patient's records." : "",
      "",
      `CONTEXT:\n${contextBlock}`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };

  const provider = chatProvider(opts.preferProvider, opts.tenantAi);
  const result = await provider.chat([system, { role: "user", content: query }], { temperature: 0.1, maxTokens: 800 });

  const confidence = computeConfidence({ chunks: retrieved, answer: result.content });
  const citations = buildCitations(retrieved, names, result.content);

  return {
    answer: result.content,
    citations,
    chunks: retrieved,
    provider: result.provider,
    model: result.model,
    confidence,
    grounded: retrieved.length > 0 && confidence >= GROUNDED_THRESHOLD,
    latencyMs: Date.now() - started,
  };
}

/** The answer given when retrieval found nothing that answers the question. */
export function noMatchingRecordsAnswer(query: string): string {
  const q = query.length > 120 ? `${query.slice(0, 119)}…` : query;
  return `No matching records were found for "${q}". The clinic's indexed records do not contain information that answers this question, and ClinicMind does not answer clinical questions without matching records.`;
}

/**
 * Citations for the context items the answer actually cites; when the answer
 * carries no markers at all, every retrieved item is listed so the reader can
 * see what the answer was derived from.
 */
export function buildCitations(chunks: RetrievedChunk[], names: Map<string, string>, answer: string): Citation[] {
  const cited = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) cited.add(Number(m[1]));
  return chunks
    .map((c, i) => ({ chunk: c, index: i + 1 }))
    .filter(({ index }) => cited.size === 0 || cited.has(index))
    .map(({ chunk, index }) => {
      const patientName = chunk.patientId ? (names.get(chunk.patientId) ?? chunk.metadata?.patientName ?? null) : null;
      return {
        index,
        source: chunk.source,
        refId: chunk.refId,
        patientId: chunk.patientId,
        patientName,
        title: chunk.metadata?.title ?? defaultTitle(chunk.source),
        snippet: snippetOf(chunk.content),
        href: chunk.patientId ? `/dashboard/patients/${encodeURIComponent(chunk.patientId)}` : null,
      };
    });
}

/**
 * Salient terms for the lexical pass: words of 3+ characters that are not
 * stopwords or generic clinic vocabulary, longest first, at most six.
 */
export function extractLexicalTerms(query: string): string[] {
  const seen = new Set<string>();
  const words = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, "").replace(/['’]s$/u, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  for (const w of words) seen.add(w);
  return [...seen].sort((a, b) => b.length - a.length).slice(0, 6);
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had", "are", "was", "were", "been", "being",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "does", "did", "do", "any", "all", "some",
  "about", "into", "over", "under", "after", "before", "between", "their", "there", "they", "them", "then", "than",
  "his", "her", "him", "she", "our", "you", "your", "its", "it's", "can", "could", "should", "would", "will", "may",
  "might", "not", "but", "yet", "also", "just", "only", "more", "most", "very", "much", "many", "each", "every",
  "show", "list", "find", "give", "tell", "summarise", "summarize", "summary", "compare", "please", "want", "need",
  "patient", "patients", "record", "records", "clinic", "today", "last", "recent", "recently", "currently", "current",
  "taking", "take", "takes", "still", "ever", "again", "out", "off", "per", "via", "these", "those", "here",
]);

function headingFor(chunk: RetrievedChunk, names: Map<string, string>): string {
  const parts = [chunk.source];
  if (chunk.metadata?.title) parts.push(chunk.metadata.title);
  const name = chunk.patientId ? (names.get(chunk.patientId) ?? chunk.metadata?.patientName) : null;
  if (name) parts.push(`patient: ${name}`);
  if (chunk.metadata?.occurredAt) parts.push(chunk.metadata.occurredAt.slice(0, 10));
  return parts.join(" · ");
}

async function patientNames(tenantId: string, chunks: RetrievedChunk[]): Promise<Map<string, string>> {
  const ids = [...new Set(chunks.map((c) => c.patientId).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return new Map();
  const patients = await db.patient.findMany({
    where: { tenantId, id: { in: ids }, ...notDeleted },
    select: { id: true, fullName: true },
  });
  return new Map(patients.map((p) => [p.id, p.fullName]));
}

function parseMetadata(value: unknown): ChunkMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const m = value as Partial<ChunkMetadata>;
  if (typeof m.title !== "string" || typeof m.kind !== "string" || typeof m.model !== "string") return null;
  return {
    title: m.title,
    occurredAt: typeof m.occurredAt === "string" ? m.occurredAt : null,
    kind: m.kind,
    model: m.model,
    provider: typeof m.provider === "string" ? m.provider : undefined,
    patientName: typeof m.patientName === "string" ? m.patientName : null,
    chunkCount: typeof m.chunkCount === "number" ? m.chunkCount : undefined,
  };
}

function defaultTitle(source: string): string {
  switch (source) {
    case "DIAGNOSIS":
      return "Medical history";
    case "MEDICATION":
      return "Medications";
    case "VISIT_NOTE":
      return "Visit";
    case "TRANSCRIPT":
      return "Consultation";
    case "CONVERSATION":
      return "Conversation";
    default:
      return source;
  }
}

function snippetOf(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

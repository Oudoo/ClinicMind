import { db, notDeleted } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { Pseudonyms, type Identity } from "./deidentify";
import { patientIdentities, staffNames } from "./identities";
import { chatProvider, embeddingProvider, type TenantAiOverrides } from "./provider";
import type { AiMessage } from "./types";
import { toVectorLiteral } from "./vectors";

/**
 * Retrieval-Augmented Generation for the Doctor AI Chat.
 *
 * Hard rule: the assistant NEVER answers without retrieval. Every answer is
 * grounded in tenant-scoped patient knowledge and returns citations.
 *
 * Retrieval returns the most relevant snippets, never every record, so it is
 * NOT how "list every patient who …" questions are answered: those go through
 * the structured cohort path (src/modules/assistant/cohort.ts), which queries
 * every record. When a list-shaped question still lands here, the answer says
 * that it may be incomplete.
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
  /** The vector was made from the text without the patient's name, numbers or e-mail; older ones are made again. */
  deidentified?: boolean;
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
  /**
   * Restrict retrieval to these patients (the patients who meet a question's
   * stated criteria, e.g. "female patients over 40"). An empty list retrieves
   * nothing. Chunks without a patient are excluded whenever a set is given.
   */
  patientIds?: string[] | null;
  /** Patients the question names (or is about): their names never reach the embedding provider. */
  people?: Identity[];
}

export interface AnswerOptions {
  topK?: number;
  patientId?: string | null;
  patientIds?: string[] | null;
  /** Plain-English description of the patient restriction, stated in the prompt. */
  scope?: string | null;
  /** The question asks for a list of patients: the answer must not present retrieval as complete. */
  listQuestion?: boolean;
  preferProvider?: string;
  tenantAi?: TenantAiOverrides;
  /** Patients the question names (or is about), beside those whose records are retrieved: labelled too. */
  people?: Identity[];
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
  if (opts.patientIds && !opts.patientIds.length) return [];
  const filter = patientFilterSql(opts.patientId ?? null, opts.patientIds ?? null);
  const terms = extractLexicalTerms(query);

  // The question leaves the clinic only to be embedded: without the patients it names, their numbers or e-mail.
  // The lexical pass runs here, on the question as asked, and still finds a record by name.
  const [vectorRows, lexicalRows] = await Promise.all([
    vectorSearch(tenantId, new Pseudonyms(opts.people ?? [], { single: true }).scrub(query), filter, topK * 2),
    terms.length ? lexicalSearch(tenantId, terms, filter, topK * 2) : Promise.resolve([] as LexicalRow[]),
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

/** SQL restriction to one patient and/or a set of patients (both are tenant-scoped by the caller's WHERE). */
function patientFilterSql(patientId: string | null, patientIds: string[] | null): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (patientId) parts.push(Prisma.sql`AND "patientId" = ${patientId}`);
  if (patientIds) parts.push(Prisma.sql`AND "patientId" = ANY(${patientIds})`);
  return parts.length ? Prisma.join(parts, " ") : Prisma.empty;
}

async function vectorSearch(tenantId: string, query: string, patientFilter: Prisma.Sql, limit: number): Promise<VectorRow[]> {
  const { vectors } = await embeddingProvider().embed([query], { kind: "query" });
  const queryVec = vectors[0];
  if (!queryVec) return [];
  const literal = toVectorLiteral(queryVec);

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

async function lexicalSearch(tenantId: string, terms: string[], patientFilter: Prisma.Sql, limit: number): Promise<LexicalRow[]> {
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
export async function answerWithRag(tenantId: string, query: string, opts: AnswerOptions = {}): Promise<RagAnswer> {
  const started = Date.now();
  const allowed = opts.patientIds ? new Set(opts.patientIds) : null;
  const retrieved = (await retrieve(tenantId, query, { topK: opts.topK ?? 8, patientId: opts.patientId, patientIds: opts.patientIds, people: opts.people }))
    .filter((c) => c.score >= CONTEXT_SCORE_FLOOR)
    // Defence in depth: never let a chunk about another patient through a restriction.
    .filter((c) => (!opts.patientId || c.patientId === opts.patientId) && (!allowed || (c.patientId !== null && allowed.has(c.patientId))))
    .slice(0, 6);
  const names = await patientNames(tenantId, retrieved);

  // Gate before generation: when even a fully cited answer could not reach the
  // grounded threshold, the records do not answer the question. Say so instead
  // of asking a model to summarise near-misses, which reads like an answer.
  const ceiling = computeConfidence({ chunks: retrieved, answer: "[1]" });
  if (!retrieved.length || ceiling < GROUNDED_THRESHOLD) {
    return {
      answer: noMatchingRecordsAnswer(query, { listQuestion: opts.listQuestion }),
      citations: [],
      chunks: retrieved,
      provider: "clinicmind",
      model: "retrieval-gate",
      confidence: computeConfidence({ chunks: retrieved, answer: "" }),
      grounded: false,
      latencyMs: Date.now() - started,
    };
  }

  // What reaches the provider: each patient as a label (Patient A, B…), their numbers, e-mail and date of
  // birth out, staff names kept; the answer comes back with the real names (lib/ai/deidentify.ts).
  const [identities, staff] = await Promise.all([
    patientIdentities(tenantId, [...retrieved.map((c) => c.patientId ?? ""), ...(opts.people ?? []).map((p) => p.id ?? "")]),
    staffNames(tenantId),
  ]);
  const pseudonyms = new Pseudonyms(identities, { keep: staff });
  const contextBlock = retrieved.map((c, i) => `[${i + 1}] ${pseudonyms.scrub(headingFor(c, pseudonyms))}\n${pseudonyms.scrub(c.content)}`).join("\n\n");
  const system: AiMessage = {
    role: "system",
    content: buildSystemPrompt({
      contextBlock,
      singlePatient: Boolean(opts.patientId),
      scope: opts.scope ? pseudonyms.scrub(opts.scope) : null,
      listQuestion: Boolean(opts.listQuestion),
    }),
  };

  const provider = chatProvider(opts.preferProvider, opts.tenantAi);
  const result = await provider.chat([system, { role: "user", content: pseudonyms.scrub(query) }], { temperature: 0.1, maxTokens: 800 });
  const answer = pseudonyms.restore(result.content);

  const confidence = computeConfidence({ chunks: retrieved, answer });
  const citations = buildCitations(retrieved, names, answer);

  return {
    answer,
    citations,
    chunks: retrieved,
    provider: result.provider,
    model: result.model,
    confidence,
    // An answer that cites nothing is not grounded, however good the retrieval was.
    grounded: citations.length > 0 && confidence >= GROUNDED_THRESHOLD,
    latencyMs: Date.now() - started,
  };
}

/**
 * The system prompt: answer only from the context, cite every fact, and the
 * grounding rule for patients: name only patients whose records are in the
 * context, cite each one, and never present retrieved records as a complete
 * list of patients.
 */
export function buildSystemPrompt(input: { contextBlock: string; singlePatient: boolean; scope: string | null; listQuestion: boolean }): string {
  return [
    "You are ClinicMind's clinical assistant. You provide decision support to licensed clinic staff; you do not give medical advice to patients.",
    "Answer ONLY from the CONTEXT below, which is retrieved from this clinic's own patient records.",
    "Cite every statement of fact with the [n] marker of the context item it comes from; a statement without a marker is not allowed.",
    "Never invent or infer diagnoses, medications, doses, dates, lab values or outcomes that are not written in the context. Do not generalise from one patient to another.",
    "Grounding rule for patients: name a patient only if their record is in the CONTEXT, put the [n] marker of that patient's record next to the name every time, and never mention any other patient. The patients you name must be exactly the patients you cite.",
    "If a question states criteria (sex, age, an allergy, a condition, a medication), never name a patient whose record does not show that they meet every one of them.",
    "If the context does not contain the answer, or only partly answers, say so plainly (for example: \"The records do not contain …\") instead of guessing.",
    "Be concise and clinical. Patients are named by labels (Patient A, Patient B…): use the labels exactly as they appear and never guess a real name. Answer in the language of the question.",
    input.singlePatient ? "The question is about a single patient; the context is restricted to that patient's records." : "",
    input.scope ? `Every record in the CONTEXT belongs to a patient who matches: ${input.scope}. Do not describe anyone outside that group.` : "",
    input.listQuestion
      ? "The CONTEXT holds only the most relevant records, not every patient of the clinic. Never present a list of patients as complete; say that it may be incomplete."
      : "",
    "",
    `CONTEXT:\n${input.contextBlock || "(none)"}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The answer given when retrieval found nothing that answers the question. */
export function noMatchingRecordsAnswer(query: string, opts: { listQuestion?: boolean } = {}): string {
  const q = query.length > 120 ? `${query.slice(0, 119)}…` : query;
  const base = `No matching records were found for "${q}". The clinic's indexed records do not contain information that answers this question, and ClinicMind does not answer clinical questions without matching records.`;
  return opts.listQuestion
    ? `${base} This was a search of the most relevant records, not a check of every patient: it does not show that no patient matches.`
    : base;
}

/**
 * Citations for the context items the answer actually cites (markers outside
 * the context are ignored). Every patient the answer names from the context
 * is cited, even where the model forgot the marker, so the patients named and
 * the patients cited are the same. An answer without any marker cites
 * nothing: listing everything retrieved under it would make records it did
 * not use look like its sources.
 */
export function buildCitations(chunks: RetrievedChunk[], names: Map<string, string>, answer: string): Citation[] {
  const cited = new Set<number>();
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= chunks.length) cited.add(n);
  }
  if (!cited.size) return [];
  // A context patient named in the answer without a marker: cite their first chunk.
  const citedPatients = new Set([...cited].map((n) => chunks[n - 1]?.patientId).filter(Boolean));
  chunks.forEach((c, i) => {
    if (!c.patientId || citedPatients.has(c.patientId)) return;
    const name = names.get(c.patientId) ?? c.metadata?.patientName ?? null;
    if (name && mentions(answer, name)) {
      cited.add(i + 1);
      citedPatients.add(c.patientId);
    }
  });
  return chunks
    .map((c, i) => ({ chunk: c, index: i + 1 }))
    .filter(({ index }) => cited.has(index))
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

/** Whole-word, case-insensitive mention of a name in a text. */
export function mentions(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  if (!escaped) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
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

function headingFor(chunk: RetrievedChunk, pseudonyms: Pseudonyms): string {
  const parts = [chunk.source];
  if (chunk.metadata?.title) parts.push(chunk.metadata.title);
  const label = chunk.patientId ? pseudonyms.labelOf(chunk.patientId) : null;
  if (label) parts.push(`patient: ${label}`);
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

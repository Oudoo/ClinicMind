import { Prisma, type EmbeddingSource } from "@prisma/client";
import { db, notDeleted, withTenant } from "@/lib/db";
import { embeddingProvider } from "@/lib/ai/provider";
import type { ChunkMetadata } from "@/lib/ai/rag";
import { toVectorLiteral } from "@/lib/ai/vectors";
import { chunkText } from "./chunking";
import {
  renderConsultationDocument,
  renderConversationDocument,
  renderPatientHistoryDocument,
  renderPatientMedicationsDocument,
  renderVisitDocument,
  type KnowledgeDocument,
} from "./documents";

/**
 * RAG ingestion: turns clinical records into tenant-scoped, embedded chunks in
 * `knowledge_embeddings`.
 *
 * Public API (call these from the patient / appointment / consultation /
 * conversation services after a write):
 *
 *   ingestPatient(tenantId, patientId)            profile+history and medications
 *   ingestVisit(tenantId, visitId)                one visit note
 *   ingestConsultation(tenantId, consultationId)  signed consultations only
 *   ingestConversation(tenantId, conversationId)  conversation summary
 *   removePatientKnowledge(tenantId, patientId)   on archive
 *   reindexTenant(tenantId, { log })              everything, with counts
 *   ingestInBackground(task)                      fire-and-forget wrapper
 *
 * Every write is idempotent: chunks are keyed by (tenantId, source, refId,
 * chunkIndex); an unchanged content hash (for the same embedding model) skips
 * the embedding call, changed chunks are re-embedded, and chunks beyond the new
 * count are deleted. The vector column is `Unsupported("vector(1536)")`, so the
 * embedding itself is written with `$executeRaw` after the row is upserted
 * through Prisma, inside one transaction.
 */

export interface IngestResult {
  source: EmbeddingSource;
  refId: string;
  /** Chunks the document now has. */
  chunks: number;
  /** Chunks sent to the embedding provider in this run. */
  embedded: number;
  /** Chunks whose content (and embedding model) were unchanged. */
  skipped: number;
  /** Stale chunks removed. */
  deleted: number;
}

export interface ReindexCounts {
  patients: number;
  visits: number;
  consultations: number;
  conversations: number;
  chunks: { embedded: number; skipped: number; deleted: number };
  /** Entities whose ingestion failed (logged, not thrown). */
  errors: number;
}

export type IngestTask = {
  kind: "patient" | "visit" | "consultation" | "conversation";
  tenantId: string;
  id: string;
};

const PATIENT_SOURCES: EmbeddingSource[] = ["DIAGNOSIS", "MEDICATION"];
const UPCOMING_STATUSES = ["SCHEDULED", "CONFIRMED", "WAITLISTED", "CHECKED_IN"] as const;

// ── Entity ingestion ─────────────────────────────────────────────────────────

/**
 * Index a patient's profile + medical history (DIAGNOSIS) and medication list
 * (MEDICATION). An archived or unknown patient has its knowledge removed.
 */
export async function ingestPatient(tenantId: string, patientId: string): Promise<IngestResult[]> {
  const patient = await db.patient.findFirst({
    where: { id: patientId, tenantId, ...notDeleted },
    include: {
      medicalHistory: true,
      medications: { orderBy: { createdAt: "asc" } },
      appointments: {
        where: { ...notDeleted, startsAt: { gte: new Date() }, status: { in: [...UPCOMING_STATUSES] } },
        orderBy: { startsAt: "asc" },
        take: 5,
        select: { startsAt: true, status: true, reason: true },
      },
    },
  });

  if (!patient) {
    const deleted = await removePatientKnowledge(tenantId, patientId);
    return PATIENT_SOURCES.map((source) => ({ source, refId: patientId, chunks: 0, embedded: 0, skipped: 0, deleted }));
  }

  const profile = {
    id: patient.id,
    fullName: patient.fullName,
    gender: patient.gender,
    dateOfBirth: patient.dateOfBirth,
    language: patient.language,
    tags: patient.tags,
    notes: patient.notes,
  };
  const history = patient.medicalHistory
    ? {
        chronicConditions: patient.medicalHistory.chronicConditions,
        allergies: patient.medicalHistory.allergies,
        surgeries: patient.medicalHistory.surgeries,
        diagnoses: patient.medicalHistory.diagnoses,
        symptoms: patient.medicalHistory.symptoms,
      }
    : null;

  const documents = [
    renderPatientHistoryDocument(profile, history, patient.medications, patient.appointments),
    renderPatientMedicationsDocument(profile, patient.medications),
  ];
  const results: IngestResult[] = [];
  for (const doc of documents) results.push(await syncDocument(tenantId, doc));
  return results;
}

/** Index one visit (VISIT_NOTE). A visit of an archived patient is removed from the store. */
export async function ingestVisit(tenantId: string, visitId: string): Promise<IngestResult> {
  const visit = await db.visit.findFirst({
    where: { id: visitId, tenantId },
    include: {
      patient: { select: { fullName: true, deletedAt: true } },
      doctor: { select: { fullName: true, email: true } },
    },
  });
  if (!visit || visit.patient.deletedAt) {
    return removeDocument(tenantId, "VISIT_NOTE", visitId);
  }
  const doc = renderVisitDocument(
    {
      id: visit.id,
      patientId: visit.patientId,
      createdAt: visit.createdAt,
      doctorName: visit.doctor?.fullName ?? visit.doctor?.email ?? null,
      summary: visit.summary,
      notes: visit.notes,
      transcript: visit.transcript,
    },
    visit.patient.fullName,
  );
  return syncDocument(tenantId, doc);
}

/**
 * Index a signed consultation (TRANSCRIPT): structured extraction + summary +
 * transcript. Anything not SIGNED (pending review, discarded, in progress) is
 * never indexed; stale chunks from an earlier state are removed.
 */
export async function ingestConsultation(tenantId: string, consultationId: string): Promise<IngestResult> {
  const consultation = await db.consultation.findFirst({
    where: { id: consultationId, tenantId },
    include: { patient: { select: { fullName: true, deletedAt: true } } },
  });
  if (!consultation || consultation.status !== "SIGNED" || consultation.patient.deletedAt) {
    return removeDocument(tenantId, "TRANSCRIPT", consultationId);
  }
  const doc = renderConsultationDocument(
    {
      id: consultation.id,
      patientId: consultation.patientId,
      createdAt: consultation.createdAt,
      reviewedAt: consultation.reviewedAt,
      summary: consultation.summary,
      transcript: consultation.transcript,
      extraction: consultation.extraction,
    },
    consultation.patient.fullName,
  );
  return syncDocument(tenantId, doc);
}

/** Index a conversation summary (CONVERSATION). */
export async function ingestConversation(tenantId: string, conversationId: string): Promise<IngestResult> {
  const conversation = await db.conversation.findFirst({
    where: { id: conversationId, tenantId },
    include: {
      patient: { select: { fullName: true, deletedAt: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 10, select: { direction: true, body: true, createdAt: true } },
    },
  });
  if (!conversation || conversation.patient?.deletedAt) {
    return removeDocument(tenantId, "CONVERSATION", conversationId);
  }
  const doc = renderConversationDocument(
    {
      id: conversation.id,
      patientId: conversation.patientId,
      channel: conversation.channel,
      locale: conversation.locale,
      createdAt: conversation.createdAt,
      summary: conversation.summary,
      transcript: conversation.transcript,
      messages: conversation.messages,
    },
    conversation.patient?.fullName ?? null,
  );
  if (!doc) return removeDocument(tenantId, "CONVERSATION", conversationId);
  return syncDocument(tenantId, doc);
}

/** Remove every chunk about a patient (archive / erasure). Returns the number of rows deleted. */
export async function removePatientKnowledge(tenantId: string, patientId: string): Promise<number> {
  const byPatient = await db.knowledgeEmbedding.deleteMany({ where: { tenantId, patientId } });
  const byRef = await db.knowledgeEmbedding.deleteMany({
    where: { tenantId, source: { in: PATIENT_SOURCES }, refId: patientId },
  });
  return byPatient.count + byRef.count;
}

// ── Whole-tenant re-index ────────────────────────────────────────────────────

/**
 * Re-index everything a tenant has: every unarchived patient, every visit,
 * every signed consultation and every conversation. Unchanged chunks are
 * skipped, so a re-run is cheap. Knowledge of archived patients and of records
 * that no longer exist is pruned. Per-entity failures are logged and counted,
 * never thrown, so one bad record cannot stop the run.
 */
export async function reindexTenant(tenantId: string, opts: { log?: (line: string) => void } = {}): Promise<ReindexCounts> {
  const log = opts.log ?? (() => undefined);
  const counts: ReindexCounts = {
    patients: 0,
    visits: 0,
    consultations: 0,
    conversations: 0,
    chunks: { embedded: 0, skipped: 0, deleted: 0 },
    errors: 0,
  };
  const add = (results: IngestResult | IngestResult[]) => {
    for (const r of Array.isArray(results) ? results : [results]) {
      counts.chunks.embedded += r.embedded;
      counts.chunks.skipped += r.skipped;
      counts.chunks.deleted += r.deleted;
    }
  };
  const attempt = async (label: string, run: () => Promise<IngestResult | IngestResult[]>, onOk: () => void) => {
    try {
      add(await run());
      onOk();
    } catch (err) {
      counts.errors += 1;
      console.error(`[knowledge] reindex: ${label} failed`, err);
    }
  };

  // Archived patients must not surface in answers.
  const archived = await db.patient.findMany({ where: { tenantId, deletedAt: { not: null } }, select: { id: true } });
  if (archived.length) {
    const pruned = await db.knowledgeEmbedding.deleteMany({
      where: { tenantId, patientId: { in: archived.map((p) => p.id) } },
    });
    counts.chunks.deleted += pruned.count;
  }

  const patients = await db.patient.findMany({ where: { tenantId, ...notDeleted }, select: { id: true }, orderBy: { createdAt: "asc" } });
  log(`patients: ${patients.length}`);
  for (const p of patients) {
    await attempt(`patient ${p.id}`, () => ingestPatient(tenantId, p.id), () => (counts.patients += 1));
  }
  counts.chunks.deleted += await pruneOrphans(tenantId, PATIENT_SOURCES, new Set(patients.map((p) => p.id)));

  const visits = await db.visit.findMany({ where: { tenantId, patient: notDeleted }, select: { id: true }, orderBy: { createdAt: "asc" } });
  log(`visits: ${visits.length}`);
  for (const v of visits) {
    await attempt(`visit ${v.id}`, () => ingestVisit(tenantId, v.id), () => (counts.visits += 1));
  }
  counts.chunks.deleted += await pruneOrphans(tenantId, ["VISIT_NOTE"], new Set(visits.map((v) => v.id)));

  const consultations = await db.consultation.findMany({
    where: { tenantId, status: "SIGNED", patient: notDeleted },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  log(`signed consultations: ${consultations.length}`);
  for (const c of consultations) {
    await attempt(`consultation ${c.id}`, () => ingestConsultation(tenantId, c.id), () => (counts.consultations += 1));
  }
  counts.chunks.deleted += await pruneOrphans(tenantId, ["TRANSCRIPT"], new Set(consultations.map((c) => c.id)));

  const conversations = await db.conversation.findMany({ where: { tenantId }, select: { id: true }, orderBy: { createdAt: "asc" } });
  log(`conversations: ${conversations.length}`);
  for (const c of conversations) {
    await attempt(`conversation ${c.id}`, () => ingestConversation(tenantId, c.id), () => (counts.conversations += 1));
  }
  counts.chunks.deleted += await pruneOrphans(tenantId, ["CONVERSATION"], new Set(conversations.map((c) => c.id)));

  log(
    `done: ${counts.patients} patients, ${counts.visits} visits, ${counts.consultations} consultations, ${counts.conversations} conversations; ` +
      `chunks embedded ${counts.chunks.embedded}, unchanged ${counts.chunks.skipped}, deleted ${counts.chunks.deleted}; errors ${counts.errors}`,
  );
  return counts;
}

/** Delete chunks of the given sources whose refId is no longer a live record. */
async function pruneOrphans(tenantId: string, sources: EmbeddingSource[], live: Set<string>): Promise<number> {
  const rows = await db.knowledgeEmbedding.findMany({
    where: { tenantId, source: { in: sources } },
    select: { refId: true },
    distinct: ["refId"],
  });
  const orphans = rows.map((r) => r.refId).filter((id) => !live.has(id));
  if (!orphans.length) return 0;
  const result = await db.knowledgeEmbedding.deleteMany({ where: { tenantId, source: { in: sources }, refId: { in: orphans } } });
  return result.count;
}

// ── Background execution ─────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<void>>();

/** Run one ingestion task and return its result (awaitable form of `ingestInBackground`). */
export function runIngestTask(task: IngestTask): Promise<IngestResult | IngestResult[]> {
  switch (task.kind) {
    case "patient":
      return ingestPatient(task.tenantId, task.id);
    case "visit":
      return ingestVisit(task.tenantId, task.id);
    case "consultation":
      return ingestConsultation(task.tenantId, task.id);
    case "conversation":
      return ingestConversation(task.tenantId, task.id);
  }
}

/**
 * Run an ingestion task without awaiting it. Failures are logged with the
 * `[knowledge]` prefix and never propagate to the caller. Tasks for the same
 * record are serialised so two quick writes cannot race each other; the later
 * run always sees the latest state. There is no queue infrastructure yet: this
 * runs in-process, so it suits a long-lived server (the Docker deployment), not
 * a per-request serverless runtime.
 */
export function ingestInBackground(task: IngestTask): void {
  const key = `${task.kind}:${task.tenantId}:${task.id}`;
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run: Promise<void> = previous
    .then(() => withTenant(task.tenantId, () => runIngestTask(task)))
    .then(
      () => undefined,
      (err: unknown) => {
        console.error(`[knowledge] ${task.kind} ${task.id} ingestion failed`, err);
      },
    )
    .finally(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
  inFlight.set(key, run);
}

/** Wait for every background task started so far (tests, graceful shutdown). */
export async function flushBackgroundIngestion(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight.values()]);
}

// ── Chunk synchronisation ────────────────────────────────────────────────────

interface ExistingChunk {
  id: string;
  chunkIndex: number;
  contentHash: string | null;
  metadata: unknown;
  hasEmbedding: boolean;
}

/**
 * Bring the store in line with one document: upsert each chunk, embed only
 * what changed (or was produced with another embedding model), and delete
 * chunks past the end of the new document.
 */
export async function syncDocument(tenantId: string, doc: KnowledgeDocument): Promise<IngestResult> {
  const chunks = chunkText(doc.text);
  if (!chunks.length) return removeDocument(tenantId, doc.source, doc.refId);

  const provider = embeddingProvider();
  const model = provider.embeddingModel() ?? provider.name;

  const existing = await db.$queryRaw<ExistingChunk[]>(Prisma.sql`
    SELECT id, "chunkIndex", "contentHash", metadata, (embedding IS NOT NULL) AS "hasEmbedding"
    FROM knowledge_embeddings
    WHERE "tenantId" = ${tenantId} AND source = ${doc.source}::"EmbeddingSource" AND "refId" = ${doc.refId}
  `);
  const byIndex = new Map(existing.map((e) => [e.chunkIndex, e]));

  const stale = chunks.filter((c) => {
    const e = byIndex.get(c.index);
    return !e || !e.hasEmbedding || e.contentHash !== c.hash || embeddingModelOf(e.metadata) !== model;
  });

  // Embed outside the transaction so a slow provider never holds DB locks.
  const vectors = new Map<number, number[]>();
  if (stale.length) {
    const { vectors: embedded } = await provider.embed(
      stale.map((c) => c.content),
      { kind: "document" },
    );
    stale.forEach((c, i) => {
      const v = embedded[i];
      if (v) vectors.set(c.index, v);
    });
  }

  const deleted = await db.$transaction(
    async (tx) => {
      for (const chunk of chunks) {
        const metadata: ChunkMetadata = {
          title: doc.title,
          occurredAt: doc.occurredAt ? doc.occurredAt.toISOString() : null,
          kind: doc.kind,
          model,
          provider: provider.name,
          patientName: doc.patientName,
          chunkCount: chunks.length,
        };
        const row = await tx.knowledgeEmbedding.upsert({
          where: {
            tenantId_source_refId_chunkIndex: {
              tenantId,
              source: doc.source,
              refId: doc.refId,
              chunkIndex: chunk.index,
            },
          },
          create: {
            tenantId,
            source: doc.source,
            refId: doc.refId,
            patientId: doc.patientId,
            chunkIndex: chunk.index,
            content: chunk.content,
            contentHash: chunk.hash,
            metadata: metadata as unknown as Prisma.InputJsonObject,
          },
          update: {
            patientId: doc.patientId,
            content: chunk.content,
            contentHash: chunk.hash,
            metadata: metadata as unknown as Prisma.InputJsonObject,
          },
          select: { id: true },
        });
        const vector = vectors.get(chunk.index);
        if (vector) {
          await tx.$executeRaw`
            UPDATE knowledge_embeddings SET embedding = ${toVectorLiteral(vector)}::vector
            WHERE id = ${row.id} AND "tenantId" = ${tenantId}
          `;
        }
      }
      const removed = await tx.knowledgeEmbedding.deleteMany({
        where: { tenantId, source: doc.source, refId: doc.refId, chunkIndex: { gte: chunks.length } },
      });
      return removed.count;
    },
    { timeout: 30_000 },
  );

  return {
    source: doc.source,
    refId: doc.refId,
    chunks: chunks.length,
    embedded: vectors.size,
    skipped: chunks.length - vectors.size,
    deleted,
  };
}

async function removeDocument(tenantId: string, source: EmbeddingSource, refId: string): Promise<IngestResult> {
  const result = await db.knowledgeEmbedding.deleteMany({ where: { tenantId, source, refId } });
  return { source, refId, chunks: 0, embedded: 0, skipped: 0, deleted: result.count };
}

function embeddingModelOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const model = (metadata as { model?: unknown }).model;
  return typeof model === "string" ? model : null;
}

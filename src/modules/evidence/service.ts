import type { EvidenceSource, Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { zOptionalText, zText } from "@/lib/validation";
import { chatProvider } from "@/lib/ai/provider";
import type { AiProvider } from "@/lib/ai/types";
import { resolveTenantAi } from "@/lib/ai/tenant-config";
import { answerablePassages, answerQuestion, libraryAnswer, noGoodSource, type CandidatePassage, type EvidenceAnswer } from "./answer";
import { EVIDENCE_KIND_LABEL, EVIDENCE_KINDS, EVIDENCE_STATUS_LABEL } from "./constants";
import { evidenceContext, redactQuestion } from "./context";
import type { EvidenceAnswerDTO, EvidenceSourceDetailDTO, EvidenceSourceDTO } from "./dto";
import { splitPassages } from "./passages";

/**
 * The clinic's evidence library and the evidence panel (Phase 4).
 *
 * Doctors and the owner add sources (a guideline, drug information, one of
 * the clinic's protocols: the text itself, with who wrote it and when); the
 * owner approves them. Only approved sources answer questions; a source
 * changed after its approval waits for approval again, and a retired one
 * answers nothing more (the answers that cited it keep pointing to it).
 *
 * A question is asked from a consultation, about its patient: their age,
 * sex, pregnancy, allergies, medications and conditions go with it, never
 * their name, phone, ID or date of birth, and those are taken out of the
 * question too. The answer comes only from approved passages, each
 * statement citing its passage; "no good source" when none answers. Every
 * question and answer is logged (an AI run of kind "evidence").
 */

export class EvidenceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceError";
  }
}

export interface Actor {
  id?: string | null;
  email?: string | null;
  ip?: string | null;
}

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const EvidenceSourceInput = z.object({
  title: zText(200).min(3, "Give it a title"),
  kind: z.enum(EVIDENCE_KINDS),
  publisher: zOptionalText(200),
  year: z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(1900).max(2100).optional()),
  url: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .max(500)
      .url("A web address (https://…)")
      .refine((u) => /^https?:\/\//i.test(u), "A web address (https://…)")
      .optional(),
  ),
  language: z.enum(["en", "ar"]).default("en"),
  body: zText(60_000).min(40, "Paste the text the panel may quote (40 characters or more)"),
});
export type EvidenceSourceInput = z.input<typeof EvidenceSourceInput>;

export const EvidenceSourceUpdate = EvidenceSourceInput.partial();

export const EvidenceQuestionInput = z.object({
  question: zText(1_000).min(3, "Ask a question"),
  /** The patient the question is about (their facts go with it, without identifiers). */
  patientId: z.preprocess(blank, z.string().min(1).max(64).optional()),
});

const sourceSelect = {
  id: true,
  title: true,
  kind: true,
  publisher: true,
  year: true,
  url: true,
  language: true,
  status: true,
  approvedById: true,
  approvedAt: true,
  retiredAt: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { passages: true } },
} satisfies Prisma.EvidenceSourceSelect;

type SourceRow = Prisma.EvidenceSourceGetPayload<{ select: typeof sourceSelect }>;

async function people(tenantId: string, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({ where: { tenantId, id: { in: unique } }, select: { id: true, fullName: true, email: true } });
  return new Map(rows.map((u) => [u.id, u.fullName ?? u.email]));
}

function toDTO(r: SourceRow, who: Map<string, string>): EvidenceSourceDTO {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    kindLabel: EVIDENCE_KIND_LABEL[r.kind],
    publisher: r.publisher,
    year: r.year,
    url: r.url,
    language: r.language,
    status: r.status,
    statusLabel: EVIDENCE_STATUS_LABEL[r.status],
    approvedBy: r.approvedById ? (who.get(r.approvedById) ?? "Former staff member") : null,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    retiredAt: r.retiredAt?.toISOString() ?? null,
    createdBy: r.createdById ? (who.get(r.createdById) ?? "Former staff member") : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    passages: r._count.passages,
  };
}

const ORDER = { APPROVED: 0, DRAFT: 1, RETIRED: 2 } as const;

export async function listSources(tenantId: string): Promise<EvidenceSourceDTO[]> {
  const rows = await db.evidenceSource.findMany({ where: { tenantId }, orderBy: [{ updatedAt: "desc" }], select: sourceSelect });
  const who = await people(tenantId, rows.flatMap((r) => [r.approvedById, r.createdById]));
  return rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.title.localeCompare(b.title)).map((r) => toDTO(r, who));
}

export async function getSource(tenantId: string, id: string): Promise<EvidenceSourceDetailDTO | null> {
  const row = await db.evidenceSource.findFirst({ where: { id, tenantId }, select: { ...sourceSelect, body: true, passages: { orderBy: { index: "asc" }, select: { index: true, heading: true, content: true } } } });
  if (!row) return null;
  const who = await people(tenantId, [row.approvedById, row.createdById]);
  return { ...toDTO(row, who), body: row.body, passageList: row.passages };
}

async function requireSource(tenantId: string, id: string): Promise<EvidenceSource> {
  const row = await db.evidenceSource.findFirst({ where: { id, tenantId } });
  if (!row) throw new TenantScopeError("evidence_source", id);
  return row;
}

async function writePassages(tx: Prisma.TransactionClient, tenantId: string, sourceId: string, body: string): Promise<void> {
  await tx.evidencePassage.deleteMany({ where: { tenantId, sourceId } });
  const passages = splitPassages(body);
  if (passages.length) await tx.evidencePassage.createMany({ data: passages.map((p) => ({ tenantId, sourceId, index: p.index, heading: p.heading, content: p.content })) });
}

export async function createSource(tenantId: string, raw: unknown, actor: Actor = {}): Promise<EvidenceSourceDetailDTO> {
  const input = EvidenceSourceInput.parse(raw);
  const id = await db.$transaction(async (tx) => {
    const source = await tx.evidenceSource.create({
      data: { tenantId, title: input.title, kind: input.kind, publisher: input.publisher ?? null, year: input.year ?? null, url: input.url ?? null, language: input.language, body: input.body, createdById: actor.id ?? null },
      select: { id: true },
    });
    await writePassages(tx, tenantId, source.id, input.body);
    return source.id;
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "evidence.source.create", entity: "EvidenceSource", entityId: id, after: { title: input.title, kind: input.kind, publisher: input.publisher ?? null, year: input.year ?? null } });
  return (await getSource(tenantId, id))!;
}

/** A changed source waits for approval again when what it says or who wrote it changed. */
export async function updateSource(tenantId: string, id: string, raw: unknown, actor: Actor = {}): Promise<EvidenceSourceDetailDTO> {
  const input = EvidenceSourceUpdate.parse(raw);
  const existing = await requireSource(tenantId, id);
  if (existing.status === "RETIRED") throw new EvidenceError(409, "retired", "A retired source is not changed: add it again as a new source.");
  const reapprove = existing.status === "APPROVED" && ((input.body !== undefined && input.body !== existing.body) || (input.title !== undefined && input.title !== existing.title) || (input.publisher !== undefined && input.publisher !== existing.publisher) || (input.year !== undefined && input.year !== existing.year));
  await db.$transaction(async (tx) => {
    await tx.evidenceSource.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.publisher !== undefined ? { publisher: input.publisher ?? null } : {}),
        ...(input.year !== undefined ? { year: input.year ?? null } : {}),
        ...(input.url !== undefined ? { url: input.url ?? null } : {}),
        ...(input.language !== undefined ? { language: input.language } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(reapprove ? { status: "DRAFT", approvedAt: null, approvedById: null } : {}),
      },
    });
    if (input.body !== undefined && input.body !== existing.body) await writePassages(tx, tenantId, id, input.body);
  });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "evidence.source.update", entity: "EvidenceSource", entityId: id, before: { title: existing.title, status: existing.status }, after: { ...input, body: input.body !== undefined ? "(changed)" : undefined, ...(reapprove ? { status: "DRAFT" } : {}) } });
  return (await getSource(tenantId, id))!;
}

export async function approveSource(tenantId: string, id: string, actor: Actor = {}, now: Date = new Date()): Promise<EvidenceSourceDetailDTO> {
  const existing = await requireSource(tenantId, id);
  if (existing.status !== "DRAFT") throw new EvidenceError(409, "not_draft", existing.status === "APPROVED" ? "This source is already approved." : "A retired source is not approved again: add it as a new source.");
  const changed = await db.evidenceSource.updateMany({ where: { id, tenantId, status: "DRAFT" }, data: { status: "APPROVED", approvedAt: now, approvedById: actor.id ?? null } });
  if (!changed.count) throw new EvidenceError(409, "state_changed", "This source changed a moment ago.");
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "evidence.source.approve", entity: "EvidenceSource", entityId: id, after: { title: existing.title } });
  return (await getSource(tenantId, id))!;
}

export async function retireSource(tenantId: string, id: string, actor: Actor = {}, now: Date = new Date()): Promise<EvidenceSourceDetailDTO> {
  const existing = await requireSource(tenantId, id);
  if (existing.status === "RETIRED") throw new EvidenceError(409, "retired", "This source is already retired.");
  // A draft retired was never quoted: it is withdrawn, its approval fields left empty.
  await db.evidenceSource.update({ where: { id }, data: { status: "RETIRED", retiredAt: now } });
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "evidence.source.retire", entity: "EvidenceSource", entityId: id, before: { status: existing.status }, after: { title: existing.title } });
  return (await getSource(tenantId, id))!;
}

/** What goes with a question about this patient, for the panel to show before asking. */
export async function questionContext(tenantId: string, patientId: string, now: Date = new Date()): Promise<string[]> {
  const context = await evidenceContext(tenantId, patientId, now);
  if (!context) throw new TenantScopeError("patient", patientId);
  return context.lines;
}

/**
 * A question the doctor takes to OpenEvidence (outside the clinic): the
 * browser copies it without the patient's name and opens OpenEvidence; this
 * logs who took which question out, as it left (the patient's name, numbers
 * and e-mail taken out here too).
 */
export async function logExternalQuestion(tenantId: string, raw: unknown, actor: Actor = {}, now: Date = new Date()): Promise<{ sentQuestion: string }> {
  const input = EvidenceQuestionInput.parse(raw);
  const context = input.patientId ? await evidenceContext(tenantId, input.patientId, now) : null;
  if (input.patientId && !context) throw new TenantScopeError("patient", input.patientId);
  const sentQuestion = redactQuestion(input.question, context?.identity);
  await audit({ tenantId, actorId: actor.id, actorEmail: actor.email, ip: actor.ip, action: "evidence.openevidence", entity: "Patient", entityId: input.patientId ?? null, after: { question: sentQuestion, service: "OpenEvidence" } });
  return { sentQuestion };
}

/** `opts.provider`: the model to answer with instead of the clinic's (the demo seed answers offline). */
export async function askEvidence(tenantId: string, raw: unknown, actor: Actor = {}, now: Date = new Date(), opts: { provider?: AiProvider } = {}): Promise<EvidenceAnswerDTO> {
  const input = EvidenceQuestionInput.parse(raw);
  const started = Date.now();
  const context = input.patientId ? await evidenceContext(tenantId, input.patientId, now) : null;
  if (input.patientId && !context) throw new TenantScopeError("patient", input.patientId);
  const sent = redactQuestion(input.question, context?.identity);

  const rows = await db.evidencePassage.findMany({
    where: { tenantId, source: { status: "APPROVED" } },
    take: 5_000,
    select: { id: true, sourceId: true, heading: true, content: true, source: { select: { title: true, kind: true, publisher: true, year: true, url: true } } },
  });
  const passages: CandidatePassage[] = rows.map((r) => ({ id: r.id, sourceId: r.sourceId, title: r.source.title, heading: r.heading, content: r.content }));
  const sources = new Map(rows.map((r) => [r.sourceId, r.source]));
  const titles = new Map([...sources].map(([id, s]) => [id, s.title]));

  let answer: EvidenceAnswer;
  let error: string | null = null;
  try {
    answer = await answerQuestion(sent, passages, { provider: opts.provider ?? chatProvider(undefined, await resolveTenantAi(tenantId)), titles, context: context?.lines ?? [] });
  } catch (err) {
    // The model failed: the library's own sentences still answer, said as such.
    error = err instanceof Error ? err.message : String(err);
    answer = libraryAnswer(sent, answerablePassages(sent, passages));
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const citations = answer.cited.map((c, i) => {
    const row = byId.get(c.item.id)!;
    return {
      n: i + 1,
      sourceId: c.item.sourceId,
      passageId: c.item.id,
      title: row.source.title,
      kindLabel: EVIDENCE_KIND_LABEL[row.source.kind],
      publisher: row.source.publisher,
      year: row.source.year,
      url: row.source.url,
      heading: c.item.heading,
      passage: c.item.content,
    };
  });

  const run = await db.aiRun
    .create({
      data: {
        tenantId,
        authorId: actor.id ?? null,
        kind: "evidence",
        provider: answer.provider,
        model: answer.model,
        // What left the clinic, if anything: the question without identifiers, and the passages.
        rawPrompt: answer.prompt ?? `Question: ${sent}`,
        retrievedContext: {
          patientId: input.patientId ?? null,
          question: sent,
          context: context?.lines ?? [],
          passages: answer.cited.map((c) => ({ passageId: c.item.id, sourceId: c.item.sourceId, score: Math.round(c.score * 1000) / 1000, matched: c.matched })),
        } as Prisma.InputJsonObject,
        generatedOutput: answer.grounded ? answer.statements.map((s) => `${s.text} ${s.cites.map((n) => `[${n}]`).join("")}`).join("\n") : noGoodSource(sent),
        // The cited words themselves, kept with the answer: a source edited later does not change what was quoted.
        citations: citations.map((c) => ({ n: c.n, sourceId: c.sourceId, passageId: c.passageId, title: c.title, heading: c.heading, passage: c.passage })),
        status: error ? "FAILED" : "SUCCEEDED",
        error,
        latencyMs: Date.now() - started,
        createdAt: now,
      },
      select: { id: true },
    })
    .catch((err: unknown) => {
      console.error("[evidence] could not log the question", err);
      return null;
    });

  return {
    sentQuestion: sent,
    grounded: answer.grounded,
    noGoodSource: answer.grounded ? null : noGoodSource(sent),
    statements: answer.statements,
    citations,
    context: context?.lines ?? [],
    mode: answer.mode,
    provider: answer.provider,
    model: answer.model,
    runId: run?.id ?? null,
  };
}

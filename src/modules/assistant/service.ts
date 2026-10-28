import { Prisma } from "@prisma/client";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { answerWithRag, type Citation } from "@/lib/ai/rag";
import { AiProviderError, type TenantAiOverrides } from "@/lib/ai/provider";
import { getTenantTimezone } from "@/modules/appointments/service";
import {
  COHORT_PAGE_SIZE,
  checkPatient,
  criteriaForAudit,
  criteriaSummary,
  describeCriterionAr,
  patientHref,
  rowLine,
  runCohortQuery,
  summarizeCohort,
  type CohortFact,
  type CohortResult,
  type CohortRow,
  type PatientCheck,
} from "./cohort";
import { describeCriterion, parseCohortQuestion, type Criterion, type ParsedQuestion, type Phrase } from "./parser";
import { patientsNamedIn, resolvePatientMention, type PatientRef } from "./patients";
import { joinList, words } from "./text";

/**
 * The assistant's single entry point (POST /api/assistant).
 *
 * 1. Parse the question deterministically (parser.ts).
 * 2. Choose the path:
 *    - a part that looks like a criterion but cannot be used → ask, never a broader answer;
 *    - a question about one named patient → resolve the name (exact, then
 *      fuzzy; ask which one when several match) and answer from that patient
 *      only: a yes/no check against the chart, or retrieval restricted to them;
 *    - "list / which / who / how many patients …" → the cohort query over
 *      every record (cohort.ts), with the count, every patient and citations;
 *    - anything else → retrieval (rag.ts), restricted to the patients who meet
 *      any criteria the question states, with honest notices when a list
 *      question can only be answered from the most relevant records.
 * 3. Check the grounding of AI answers: every patient the answer names must be
 *    cited, and no cited patient may fall outside the stated criteria.
 * 4. Record every question as an AiRun ("assistant_chat" or "assistant_cohort")
 *    and an "assistant.query" audit row with the criteria (never the answer).
 */

export type AssistantMode = "cohort" | "patient" | "rag" | "clarify";

export interface AssistantRow extends CohortRow {
  index: number;
}

export interface CohortPayload {
  /** "Answered from the record: 11 patients matched (all shown)". */
  banner: string;
  headline: string;
  lines: string[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  /** Every match is on this page. */
  complete: boolean;
  rows: AssistantRow[];
  criteria: string[];
}

export interface ClarifyOption {
  label: string;
  /** Ask this question instead. */
  query?: string;
  /** Ask the same question with this patient as the context. */
  patientId?: string;
  patientName?: string;
}

export interface ClarifyPayload {
  reason: "not_understood" | "ambiguous_patient" | "patient_not_found" | "context_mismatch";
  /** Parts of the question that could not be used. */
  ignored: string[];
  /** Criteria that were understood. */
  understood: string[];
  options: ClarifyOption[];
}

export interface AssistantAnswer {
  answer: string;
  citations: Citation[];
  confidence: number;
  grounded: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  mode: AssistantMode;
  /** Plain-English criteria the question was read as. */
  criteria: string[];
  cohort?: CohortPayload;
  clarify?: ClarifyPayload;
  /** For retrieval answers: the group retrieval was limited to. */
  scope?: { label: string; patients: number | null } | null;
  /** Caveats shown with the answer (incomplete list, uncited names…). */
  notices: string[];
  aiRunId?: string | null;
}

export interface AssistantActor {
  tenantId: string;
  userId: string | null;
  email: string | null;
  ip?: string | null;
  device?: string | null;
}

export interface AskInput {
  query: string;
  /** The patient the chat is focused on (proven to belong to the tenant by the caller). */
  patientId?: string | null;
  page?: number;
}

export interface AskOptions {
  tenantAi?: TenantAiOverrides;
  now?: Date;
  /** Write the AiRun and audit rows (default true; the offline evaluation turns it off). */
  record?: boolean;
}

/** An AI provider failed; the question was still logged. */
export class AssistantProviderError extends Error {
  readonly provider: string;
  constructor(cause: AiProviderError) {
    super(cause.message);
    this.name = "AssistantProviderError";
    this.provider = cause.provider;
  }
}

interface Outcome {
  answer: Omit<AssistantAnswer, "latencyMs" | "aiRunId">;
  kind: "assistant_chat" | "assistant_cohort";
  /** RAG runs keep the historical compact shape of the retrieved context. */
  retrievedContext: Prisma.InputJsonValue;
  patientId: string | null;
  total: number | null;
}

const COHORT_MODEL = "cohort-query-v1";

export async function askAssistant(actor: AssistantActor, input: AskInput, opts: AskOptions = {}): Promise<AssistantAnswer> {
  const started = Date.now();
  const query = input.query.trim();
  const now = opts.now ?? new Date();
  const timeZone = await getTenantTimezone(actor.tenantId);
  const vocabulary = await loadVocabulary(actor.tenantId);
  const parsed = parseCohortQuestion(query, { now, timeZone, ...vocabulary });

  let outcome: Outcome;
  try {
    outcome = await decide(actor.tenantId, parsed, input, { ...opts, now, timeZone });
  } catch (err) {
    if (err instanceof AiProviderError) {
      if (opts.record !== false) await recordFailure(actor, query, parsed, err, Date.now() - started, input.patientId ?? null);
      throw new AssistantProviderError(err);
    }
    throw err;
  }

  const answer: AssistantAnswer = { ...outcome.answer, latencyMs: Date.now() - started, aiRunId: null };
  if (opts.record !== false) answer.aiRunId = await record(actor, query, parsed, outcome, answer);
  return answer;
}

// ── Choosing the path ────────────────────────────────────────────────────────

interface DecideOptions extends AskOptions {
  now: Date;
  timeZone: string;
}

async function decide(tenantId: string, parsed: ParsedQuestion, input: AskInput, opts: DecideOptions): Promise<Outcome> {
  const criteria = parsed.criteria;
  const listy = parsed.intent === "list" || parsed.intent === "count";
  const problems = parsed.problems.length > 0;

  // The chat is focused on one patient.
  if (input.patientId) {
    const focus = await db.patient.findFirst({ where: { id: input.patientId, tenantId, ...notDeleted }, select: { id: true, fullName: true } });
    if (focus) {
      const ownWords = new Set(words(focus.fullName));
      const aboutFocus = (p: Phrase) => p.words.every((w) => ownWords.has(w));
      const others = parsed.leftover.filter((p) => !aboutFocus(p));
      if (others.length) {
        const mention = await resolvePatientMention(tenantId, others, parsed.subject && !aboutFocus(parsed.subject) ? parsed.subject : null);
        if (mention.status === "resolved" && mention.patient.id !== focus.id) return clarifyContextMismatch(parsed, focus, mention.patient);
      }
      // A structured yes/no check when every part is understood; otherwise
      // retrieval over this one patient's records (nothing broader is possible).
      if (criteria.length && !others.length && !parsed.narrative && !problems) return patientCheckOutcome(tenantId, parsed, focus, opts);
      return ragOutcome(tenantId, parsed, { patient: focus, listy: false }, opts);
    }
  }

  // A named patient ("Is Tarek Ezzat on cephalexin?", "Tarek Ezzat's allergies").
  const mention = parsed.leftover.length ? await resolvePatientMention(tenantId, parsed.leftover, parsed.subject) : { status: "none" as const };
  if (mention.status === "ambiguous") return clarifyAmbiguous(parsed, mention.candidates, mention.phrase);
  if (mention.status === "not_found" && (parsed.intent === "check" || mention.phrase.possessive)) return clarifyNotFound(parsed, mention.phrase);
  if (mention.status === "resolved") {
    const remaining = parsed.leftover.filter((p) => p !== mention.phrase && p.text !== mention.phrase.text);
    const patient = { id: mention.patient.id, fullName: mention.patient.fullName };
    const notices = mention.how === "partial" ? [`Read “${mention.phrase.text}” as ${patient.fullName}, the only patient with that name.`] : mention.how === "fuzzy" ? [`Read “${mention.phrase.text}” as ${patient.fullName}.`] : [];
    const out =
      criteria.length && !remaining.length && !parsed.narrative && !problems
        ? await patientCheckOutcome(tenantId, parsed, patient, opts)
        : await ragOutcome(tenantId, parsed, { patient, listy: false }, opts);
    out.answer.notices.unshift(...notices);
    return out;
  }

  // A criterion-shaped part that cannot be used: say which, never answer a
  // broader question. (A free-form question without any criterion is left to
  // retrieval as it is.)
  if (problems && (listy || parsed.intent === "check" || criteria.length)) return clarifyNotUnderstood(parsed);

  // "Which / who / how many patients …" (or a look-up such as "what are the
  // penicillin allergies?") with every part understood: the whole record.
  const lookUp = parsed.intent === "check" || (parsed.intent === "open" && !parsed.narrative);
  if ((listy || lookUp) && criteria.length && !parsed.leftover.length) return cohortOutcome(tenantId, parsed, input.page ?? 1, opts);

  // Retrieval, restricted to the patients who meet the stated criteria.
  const asksForList = listy || parsed.intent === "check";
  if (criteria.length) {
    const cohort = await runCohortQuery(tenantId, criteria, { timeZone: opts.timeZone, now: opts.now, pageSize: COHORT_PAGE_SIZE });
    return ragOutcome(tenantId, parsed, { cohort, listy: asksForList }, opts);
  }
  return ragOutcome(tenantId, parsed, { listy: asksForList }, opts);
}

// ── Cohort answers ───────────────────────────────────────────────────────────

async function cohortOutcome(tenantId: string, parsed: ParsedQuestion, page: number, opts: DecideOptions): Promise<Outcome> {
  const result = await runCohortQuery(tenantId, parsed.criteria, {
    timeZone: opts.timeZone,
    now: opts.now,
    page,
    pageSize: COHORT_PAGE_SIZE,
    details: parsed.details,
  });
  const summary = summarizeCohort(parsed, parsed.criteria, result);
  const offset = (result.page - 1) * result.pageSize;
  const rows: AssistantRow[] = result.rows.map((r, i) => ({ ...r, index: offset + i + 1 }));
  const criteria = criteriaSummary(parsed.criteria);
  const chips = parsed.language === "ar" ? parsed.criteria.map(describeCriterionAr) : criteria;
  const banner = cohortBanner(result, parsed.language);
  const answer = [summary.headline, ...summary.lines, ...rows.map((r) => rowLine(r, r.index))].join("\n");
  return {
    kind: "assistant_cohort",
    answer: {
      answer,
      citations: rows.map(rowCitation),
      confidence: 1,
      grounded: true,
      provider: "clinicmind",
      model: COHORT_MODEL,
      mode: "cohort",
      criteria,
      cohort: {
        banner,
        headline: summary.headline,
        lines: summary.lines,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        pages: result.pages,
        complete: result.total <= result.pageSize,
        rows,
        criteria: chips,
      },
      scope: null,
      notices: [],
    },
    retrievedContext: { mode: "cohort", criteria: criteriaForAudit(parsed.criteria), total: result.total, page: result.page, pageSize: result.pageSize } as Prisma.InputJsonValue,
    patientId: null,
    total: result.total,
  };
}

export function cohortBanner(result: Pick<CohortResult, "total" | "page" | "pageSize">, language: "en" | "ar" = "en"): string {
  const n = result.total;
  if (language === "ar") {
    // "عدد المرضى المطابقين: n" reads correctly for every n (Arabic counted nouns change with the number).
    if (!n) return "الإجابة من السجلات: لا يوجد مريض مطابق";
    if (n <= result.pageSize) return `الإجابة من السجلات: عدد المرضى المطابقين ${n} (معروضين كلهم)`;
    const from = (result.page - 1) * result.pageSize + 1;
    const to = Math.min(n, result.page * result.pageSize);
    return `الإجابة من السجلات: عدد المرضى المطابقين ${n} (معروض ${from}–${to})`;
  }
  const noun = `patient${n === 1 ? "" : "s"}`;
  if (!n) return "Answered from the record: no patient matched";
  if (n <= result.pageSize) return `Answered from the record: ${n} ${noun} matched (all shown)`;
  const from = (result.page - 1) * result.pageSize + 1;
  const to = Math.min(n, result.page * result.pageSize);
  return `Answered from the record: ${n} ${noun} matched (showing ${from}–${to})`;
}

function rowCitation(row: AssistantRow): Citation {
  const first = row.facts.find((f) => !f.unmet) ?? row.facts[0];
  return {
    index: row.index,
    source: first?.source ?? "PROFILE",
    refId: first?.refId ?? row.patientId,
    patientId: row.patientId,
    patientName: row.name,
    title: first?.where ?? "Patient record",
    snippet: row.facts.map((f) => `${f.label}: ${f.value}${f.note ? ` (${f.note})` : ""}`).join(" · ").slice(0, 300),
    href: row.href,
  };
}

// ── One patient: yes / no against the chart ──────────────────────────────────

async function patientCheckOutcome(tenantId: string, parsed: ParsedQuestion, patient: PatientRef, opts: DecideOptions): Promise<Outcome> {
  const check = await checkPatient(tenantId, patient.id, parsed.criteria, { timeZone: opts.timeZone, now: opts.now, details: parsed.details });
  if (!check) return clarifyNotFound(parsed, { text: patient.fullName });
  const headline = checkHeadline(check, parsed.language);
  const facts: CohortFact[] = check.items.flatMap((i) => i.facts);
  const row: AssistantRow = { patientId: patient.id, name: check.patient.name, age: check.patient.age, sex: check.patient.sex, facts, href: patientHref(patient.id), index: 1 };
  const lines = check.items.length > 1 ? check.items.map((i) => `${i.met ? "✓" : "✗"} ${describeCriterion(i.criterion)}${i.facts.length ? ` — ${i.facts.map((f) => `${f.label}: ${f.value}`).join("; ")}` : ""}`) : [];
  const recorded = check.items.length === 1 ? check.items[0]!.facts.map((f) => `${f.label}: ${f.value}${f.note ? ` (${f.note})` : ""} · ${f.where}`) : [];
  const criteria = criteriaSummary(parsed.criteria);
  const answer = [headline, ...lines, ...recorded, `[1] ${check.patient.name} · patient record`].join("\n");
  return {
    kind: "assistant_cohort",
    answer: {
      answer,
      citations: [rowCitation(row)],
      confidence: 1,
      grounded: true,
      provider: "clinicmind",
      model: COHORT_MODEL,
      mode: "patient",
      criteria,
      cohort: {
        banner: parsed.language === "ar" ? `الإجابة من ملف ${check.patient.name}` : `Answered from the record of ${check.patient.name}`,
        headline,
        lines,
        total: 1,
        page: 1,
        pageSize: 1,
        pages: 1,
        complete: true,
        rows: [row],
        criteria,
      },
      scope: { label: check.patient.name, patients: 1 },
      notices: [],
    },
    retrievedContext: { mode: "patient", criteria: criteriaForAudit(parsed.criteria), met: check.met } as Prisma.InputJsonValue,
    patientId: patient.id,
    total: 1,
  };
}

function checkHeadline(check: PatientCheck, language: "en" | "ar"): string {
  const name = check.patient.name;
  const ar = language === "ar";
  if (check.items.length > 1) {
    const met = check.items.filter((i) => i.met).length;
    if (ar) return check.met ? `نعم — ${name} مطابق لكل الشروط (${met} من ${check.items.length}).` : `لا — ${name} مطابق لـ ${met} من ${check.items.length} شروط.`;
    return check.met ? `Yes — ${name} meets all ${check.items.length} criteria.` : `No — ${name} meets ${met} of ${check.items.length} criteria.`;
  }
  const item = check.items[0]!;
  const c = item.criterion;
  const facts = item.facts.filter((f) => !f.unmet || f.label !== "Stopped");
  const value = joinList(facts.map((f) => `${f.value}${f.note ? ` (${f.note})` : ""}`), "and");
  const terms = joinList(c.terms.map((t) => t.label), c.match === "all" ? "and" : "or");
  const anyTerm = c.terms.some((t) => t.any);
  if (ar) {
    const desc = describeCriterionAr(c);
    return item.met ? `نعم — ${name}: ${desc}. المسجل: ${value}.` : `لا — ${name}: ${desc} غير مسجل. المسجل: ${value}.`;
  }
  if (anyTerm && c.kind === "allergy") return item.met ? `${name}'s recorded allergies: ${value}.` : `No allergies are recorded for ${name}.`;
  if (anyTerm && c.kind === "procedure") return item.met ? `${name}'s recorded surgeries: ${value}.` : `No surgeries are recorded for ${name}.`;
  const verdict = item.met !== c.negate ? "Yes" : "No";
  switch (c.kind) {
    case "allergy":
      return item.met ? `${verdict} — ${name} has ${terms} recorded as an allergy: ${value}.` : `${verdict} — ${name} has no allergy to ${terms} recorded.`;
    case "condition":
      return item.met ? `${verdict} — ${name} has ${terms} recorded as a condition or diagnosis: ${value}.` : `${verdict} — ${name} has no ${terms} recorded as a condition or diagnosis.`;
    case "medication":
      return item.met ? `${verdict} — ${name} has ${terms} as an active medication: ${value}.` : `${verdict} — ${name} has no active ${terms} on record.`;
    case "procedure":
      return item.met ? `${verdict} — ${name} has ${terms} recorded: ${value}.` : `${verdict} — ${name} has no ${terms} recorded as a surgery or procedure.`;
    default:
      return item.met ? `Yes — ${name} matches: ${describeCriterion(c)} (${value}).` : `No — ${name} does not match: ${describeCriterion(c)} (recorded: ${value}).`;
  }
}

// ── Clarifications ───────────────────────────────────────────────────────────

function clarifyOutcome(parsed: ParsedQuestion, answer: string, clarify: ClarifyPayload): Outcome {
  return {
    kind: "assistant_cohort",
    answer: {
      answer,
      citations: [],
      confidence: 0,
      grounded: false,
      provider: "clinicmind",
      model: "clarify",
      mode: "clarify",
      criteria: clarify.understood,
      clarify,
      scope: null,
      notices: [],
    },
    retrievedContext: { mode: "clarify", reason: clarify.reason, criteria: criteriaForAudit(parsed.criteria) } as Prisma.InputJsonValue,
    patientId: null,
    total: null,
  };
}

function clarifyNotUnderstood(parsed: ParsedQuestion): Outcome {
  const understood = criteriaSummary(parsed.criteria);
  const ignored = parsed.problems.map((p) => p.text);
  const parts = parsed.problems.map((p) => `“${p.text}” (${p.reason})`);
  const ar = parsed.language === "ar";
  const answer = ar
    ? `ما قدرتش أستخدم ${parsed.problems.map((p) => `«${p.text}»`).join("، ")} كشرط للبحث، فما عملتش بحث أوسع من السؤال. ${understood.length ? `اللي اتفهم: ${parsed.criteria.map(describeCriterionAr).join(" · ")}.` : ""} أعد صياغة السؤال.`
    : `I could not use ${joinList(parts, "and")} as a search criterion, so I did not run a broader search than the one you asked for.${understood.length ? ` Understood: ${understood.join(" · ")}.` : ""} Please rephrase that part.`;
  const options: ClarifyOption[] = [];
  if (understood.length && parsed.criteria.length) {
    const q = rephrase(parsed.criteria);
    if (q) options.push({ label: q, query: q });
  }
  return clarifyOutcome(parsed, answer, { reason: "not_understood", ignored, understood, options });
}

function clarifyAmbiguous(parsed: ParsedQuestion, candidates: PatientRef[], phrase: Phrase): Outcome {
  const ar = parsed.language === "ar";
  const names = candidates.map((c) => c.fullName);
  const answer = ar
    ? `في أكتر من مريض اسمه «${phrase.text}»: ${names.join("، ")}. تقصد مين؟`
    : `Several patients match “${phrase.text}”: ${joinList(names, "and")}. Which one do you mean?`;
  return clarifyOutcome(parsed, answer, {
    reason: "ambiguous_patient",
    ignored: [],
    understood: criteriaSummary(parsed.criteria),
    options: candidates.map((c) => ({ label: c.fullName, patientId: c.id, patientName: c.fullName })),
  });
}

function clarifyNotFound(parsed: ParsedQuestion, phrase: Pick<Phrase, "text">): Outcome {
  const ar = parsed.language === "ar";
  const answer = ar
    ? `ما فيش مريض في العيادة اسمه «${phrase.text}». دور على المريض واختاره كسياق للسؤال.`
    : `No patient called “${phrase.text}” was found in this clinic. Search for the patient and pick them as the chat's patient context.`;
  return clarifyOutcome(parsed, answer, { reason: "patient_not_found", ignored: [phrase.text], understood: criteriaSummary(parsed.criteria), options: [] });
}

function clarifyContextMismatch(parsed: ParsedQuestion, focus: PatientRef, named: PatientRef): Outcome {
  const ar = parsed.language === "ar";
  const answer = ar
    ? `المحادثة مركزة على ${focus.fullName}، لكن السؤال عن ${named.fullName}. اختار ${named.fullName} أو امسح سياق المريض.`
    : `This chat is focused on ${focus.fullName}, but the question names ${named.fullName}. Switch to ${named.fullName} or clear the patient context to ask about them.`;
  return clarifyOutcome(parsed, answer, {
    reason: "context_mismatch",
    ignored: [],
    understood: criteriaSummary(parsed.criteria),
    options: [{ label: `Ask about ${named.fullName}`, patientId: named.id, patientName: named.fullName }],
  });
}

/** A plain question for the understood criteria ("Which patients have PCOS?"). */
function rephrase(criteria: Criterion[]): string | null {
  const parts = criteria.map(describeCriterion);
  if (!parts.length) return null;
  return `Which patients match: ${parts.join("; ")}?`;
}

// ── Retrieval answers ────────────────────────────────────────────────────────

async function ragOutcome(
  tenantId: string,
  parsed: ParsedQuestion,
  scope: { patient?: PatientRef; cohort?: CohortResult; listy: boolean },
  opts: DecideOptions,
): Promise<Outcome> {
  const criteria = criteriaSummary(parsed.criteria);
  const notices: string[] = [];
  const scopeLabel = scope.cohort ? criteria.join(" · ") : null;

  if (scope.cohort && scope.cohort.total === 0) {
    // Nobody meets the stated criteria: there are no records to answer from.
    const answer = parsed.language === "ar"
      ? `لا يوجد مريض مطابق: ${parsed.criteria.map(describeCriterionAr).join(" · ")}، فمفيش سجلات أجاوب منها.`
      : `No patient matches ${scopeLabel}, so there are no records to answer this from.`;
    return {
      kind: "assistant_chat",
      answer: { answer, citations: [], confidence: 0, grounded: false, provider: "clinicmind", model: "cohort-gate", mode: "rag", criteria, scope: { label: scopeLabel ?? "", patients: 0 }, notices },
      retrievedContext: [],
      patientId: null,
      total: 0,
    };
  }

  const allowed = scope.cohort ? scope.cohort.ids : null;
  const rag = await answerWithRag(tenantId, parsed.question, {
    patientId: scope.patient?.id ?? null,
    patientIds: allowed,
    scope: scopeLabel,
    listQuestion: scope.listy,
    tenantAi: opts.tenantAi,
  });

  // Grounding: the patients the answer names must be the patients it cites.
  let grounded = rag.grounded;
  const cited = new Set(rag.citations.map((c) => c.patientId).filter((id): id is string => Boolean(id)));
  const named = await patientsNamedIn(tenantId, rag.answer);
  const uncited = named.filter((p) => !cited.has(p.id));
  if (uncited.length) {
    grounded = false;
    notices.push(`This answer names ${joinList(uncited.map((p) => p.fullName), "and")} without citing their record. Check the chart before relying on it.`);
  }
  // No cited patient may fall outside the stated criteria or the focused patient.
  const outside = rag.citations.filter((c) => c.patientId && ((allowed && !allowed.includes(c.patientId)) || (scope.patient && c.patientId !== scope.patient.id)));
  const citations = outside.length ? rag.citations.filter((c) => !outside.includes(c)) : rag.citations;
  if (outside.length) grounded = false;

  if (scope.cohort) {
    notices.push(`Searched only the records of the ${scope.cohort.total} patient${scope.cohort.total === 1 ? "" : "s"} who match: ${scopeLabel}.`);
    if (parsed.leftover.length && scope.listy) {
      notices.push(`“${parsed.leftover.map((p) => p.text).join("”, “")}” could not be used as a search criterion; that part was answered from the most relevant records, so the answer may not list every patient.`);
    }
  } else if (scope.listy) {
    notices.push("This answer comes from the most relevant records, not from every patient's record, so it may not list every patient. For a complete list, ask by allergy, condition, medication, sex, age, tag, doctor, appointment or last visit.");
  }

  return {
    kind: "assistant_chat",
    answer: {
      answer: rag.answer,
      citations,
      confidence: rag.confidence,
      grounded,
      provider: rag.provider,
      model: rag.model,
      mode: "rag",
      criteria,
      scope: scope.patient ? { label: scope.patient.fullName, patients: 1 } : scope.cohort ? { label: scopeLabel ?? "", patients: scope.cohort.total } : null,
      notices,
    },
    retrievedContext: rag.chunks.map((c) => ({ id: c.id, source: c.source, refId: c.refId, score: c.score })),
    patientId: scope.patient?.id ?? null,
    total: null,
  };
}

// ── Vocabulary of the tenant (tags, clinicians, medication names, record terms) ──

async function loadVocabulary(tenantId: string) {
  const [tags, clinicians, meds, terms] = await Promise.all([
    db.$queryRaw<{ tag: string }[]>(Prisma.sql`
      SELECT DISTINCT unnest(tags) AS tag FROM patients WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL LIMIT 500
    `),
    db.user.findMany({
      where: { tenantId, deletedAt: null, OR: [{ isClinician: true }, { role: "DOCTOR" }] },
      select: { id: true, fullName: true, email: true },
    }),
    db.$queryRaw<{ name: string }[]>(Prisma.sql`
      SELECT DISTINCT name FROM medications WHERE "tenantId" = ${tenantId} LIMIT 2000
    `),
    db.$queryRaw<{ term: string }[]>(Prisma.sql`
      SELECT DISTINCT term FROM (
        SELECT jsonb_array_elements_text(allergies) AS term FROM medical_histories WHERE "tenantId" = ${tenantId} AND jsonb_typeof(allergies) = 'array'
        UNION ALL
        SELECT jsonb_array_elements_text("chronicConditions") FROM medical_histories WHERE "tenantId" = ${tenantId} AND jsonb_typeof("chronicConditions") = 'array'
        UNION ALL
        SELECT jsonb_array_elements_text(diagnoses) FROM medical_histories WHERE "tenantId" = ${tenantId} AND jsonb_typeof(diagnoses) = 'array'
        UNION ALL
        SELECT jsonb_array_elements_text(surgeries) FROM medical_histories WHERE "tenantId" = ${tenantId} AND jsonb_typeof(surgeries) = 'array'
      ) t LIMIT 3000
    `),
  ]);
  return {
    tags: tags.map((t) => t.tag).filter(Boolean),
    doctors: clinicians.map((u) => ({ id: u.id, name: u.fullName ?? u.email })),
    medicationNames: meds.map((m) => m.name),
    recordTerms: terms.map((t) => t.term),
  };
}

// ── Logging ──────────────────────────────────────────────────────────────────

async function record(actor: AssistantActor, query: string, parsed: ParsedQuestion, outcome: Outcome, answer: AssistantAnswer): Promise<string | null> {
  const run = await db.aiRun
    .create({
      data: {
        tenantId: actor.tenantId,
        authorId: actor.userId,
        kind: outcome.kind,
        provider: answer.provider,
        model: answer.model,
        rawPrompt: query,
        retrievedContext: outcome.retrievedContext,
        generatedOutput: answer.answer,
        citations: answer.citations.map((c) => ({ index: c.index, source: c.source, refId: c.refId, patientId: c.patientId, title: c.title })),
        confidenceScore: answer.confidence,
        status: "SUCCEEDED",
        latencyMs: answer.latencyMs,
      },
      select: { id: true },
    })
    .catch((err: unknown) => {
      console.error("[assistant] failed to record the AI run", err);
      return null;
    });
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    device: actor.device ?? null,
    action: "assistant.query",
    entity: "AiRun",
    entityId: run?.id ?? null,
    after: {
      mode: answer.mode,
      kind: outcome.kind,
      intent: parsed.intent,
      criteria: criteriaForAudit(parsed.criteria),
      understood: answer.criteria,
      notUnderstood: answer.clarify?.ignored ?? [],
      patientId: outcome.patientId,
      matched: outcome.total,
      page: answer.cohort?.page ?? null,
      patientsCited: new Set(answer.citations.map((c) => c.patientId).filter(Boolean)).size,
      provider: answer.provider,
      status: "succeeded",
    },
  });
  return run?.id ?? null;
}

async function recordFailure(actor: AssistantActor, query: string, parsed: ParsedQuestion, err: AiProviderError, latencyMs: number, patientId: string | null): Promise<void> {
  const run = await db.aiRun
    .create({
      data: {
        tenantId: actor.tenantId,
        authorId: actor.userId,
        kind: "assistant_chat",
        provider: err.provider,
        model: "",
        rawPrompt: query,
        status: "FAILED",
        error: err.message.slice(0, 500),
        latencyMs,
      },
      select: { id: true },
    })
    .catch(() => null);
  await audit({
    tenantId: actor.tenantId,
    actorId: actor.userId,
    actorEmail: actor.email,
    ip: actor.ip ?? null,
    device: actor.device ?? null,
    action: "assistant.query",
    entity: "AiRun",
    entityId: run?.id ?? null,
    after: { mode: "rag", kind: "assistant_chat", intent: parsed.intent, criteria: criteriaForAudit(parsed.criteria), patientId, provider: err.provider, status: "failed" },
  });
}

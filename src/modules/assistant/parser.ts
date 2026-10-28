import {
  addDays,
  dateKeyInTz,
  endOfDayInTz,
  startOfDayInTz,
  startOfWeekInTz,
  zonedParts,
  zonedTimeToUtc,
} from "@/lib/time";
import {
  editDistance,
  isArabic,
  isMostlyArabic,
  normalizeText,
  sameWord,
  sameWordExact,
  tidy,
  tokenize,
  typoBudget,
  variants,
  words,
  type Token,
} from "./text";
import {
  ALLERGY_PREPOSITIONS,
  ALLERGY_WORDS,
  APPOINTMENT_WORDS,
  CONCEPTS,
  CONDITION_TRIGGERS,
  COUNT_INTENT,
  DETAIL_PHRASES,
  DOCTOR_LINKS,
  DOCTOR_TITLES,
  DRUG_CLASSES,
  DURATION_UNITS,
  FILLER_PHRASES,
  FILLERS,
  HAS_TRIGGERS,
  LIST_INTENT,
  MEDICATION_TRIGGERS,
  MONTHS,
  NAME_TRANSLITERATIONS,
  NEGATED_HAS,
  NEGATED_TAKES,
  NEGATIONS,
  NO_ALLERGY_PHRASES,
  NUMBER_WORDS,
  ON_TRIGGERS,
  OPEN_INTENT,
  PROCEDURE_TRIGGERS,
  PROCEDURE_WORDS,
  SEX_WORDS,
  TAG_TRIGGERS,
  VISIT_WORDS,
  classMembers,
  conceptById,
  drugClassById,
  type ConceptKind,
} from "./vocabulary";

/**
 * Deterministic parser for the assistant's structured questions: "list /
 * which / who / how many patients …" with criteria — allergy, condition or
 * diagnosis, active medication, surgery/procedure, sex, age, tag, doctor,
 * upcoming appointment and "no visit since". English and Egyptian Arabic,
 * tolerant of typos, plurals and spelling variants. No AI is involved, so the
 * same question always yields the same criteria.
 *
 * The parser never guesses silently. Every part of the question ends up as a
 * criterion, a filler word, a requested detail ("at what dose"), a possible
 * patient name, or a reported problem; the caller refuses to answer a broader
 * question than the one asked.
 */

export type CriterionKind =
  | "allergy"
  | "condition"
  | "medication"
  | "procedure"
  | "sex"
  | "age"
  | "tag"
  | "doctor"
  | "appointment"
  | "lastVisit";

export type Detail = "dose" | "medications" | "grafts" | "dates" | "age";
export type Sex = "MALE" | "FEMALE";

export interface TermSpec {
  /** The words as typed ("Roaccutane", "penicilin"). */
  input: string;
  /** Canonical label ("isotretinoin", "penicillin"). */
  label: string;
  conceptId: string | null;
  classId: string | null;
  /** Set when an allergy question was widened to a cross-reactive class. */
  classLabel: string | null;
  /** Normalised phrases searched in the chart (synonyms, brands, Arabic). */
  phrases: string[][];
  /** Concept that each phrase belongs to (null for free text), to label class matches. */
  phraseOwners: (string | null)[];
  /** A typo in the question was corrected to `label`. */
  corrected: boolean;
  /** Strength asked for ("20 mg", "5%"), matched against the medication's name and dose. */
  strength: string | null;
  /** "Any allergy" (no specific agent). */
  any: boolean;
}

export interface AgeRange {
  /** Inclusive, in completed years. */
  min: number | null;
  max: number | null;
  text: string;
}

export interface TimeWindow {
  from: string;
  to: string | null;
  label: string;
  /** Only appointments still to come (not completed or missed). */
  upcomingOnly: boolean;
}

export interface Criterion {
  kind: CriterionKind;
  negate: boolean;
  /** How several terms combine: "lidocaine or penicillin" → any, "diabetes and hypertension" → all. */
  match: "any" | "all";
  terms: TermSpec[];
  sexes?: Sex[];
  age?: AgeRange;
  tags?: string[];
  doctors?: { id: string; name: string }[];
  window?: TimeWindow;
  /** No visit since `before` (null: no visit on record at all). */
  cutoff?: { before: string | null; label: string };
  /** The words of the question this criterion came from. */
  source: string;
  span: [number, number];
}

export interface Phrase {
  text: string;
  tokens: number[];
  words: string[];
  possessive: boolean;
}

export interface ParseProblem {
  text: string;
  reason: string;
}

export type Intent = "list" | "count" | "check" | "open";

export interface ParsedQuestion {
  question: string;
  language: "en" | "ar";
  intent: Intent;
  criteria: Criterion[];
  details: Detail[];
  /** Content words that are not criteria, fillers or details (patient names, or parts not understood). */
  leftover: Phrase[];
  /** Criterion-shaped parts that could not be used (unknown doctor, dangling "not", "or" across kinds…). */
  problems: ParseProblem[];
  /** The person a yes/no question is about ("Is <Tarek Ezzat> on …"). */
  subject: Phrase | null;
  /** The question asks for prose (summarise, compare, explain), not a look-up. */
  narrative: boolean;
  tokens: Token[];
}

export interface ParseContext {
  now?: Date;
  timeZone?: string;
  /** The tenant's patient tags. */
  tags?: string[];
  /** The tenant's clinicians. */
  doctors?: { id: string; name: string }[];
  /** Medication names on the tenant's records (recognises local brands). */
  medicationNames?: string[];
  /** Allergy, condition and surgery entries on the tenant's records (typo correction). */
  recordTerms?: string[];
}

// ── Lexicons (normalised once) ───────────────────────────────────────────────

type Lex = string[][];

const lex = (list: string[]): Lex =>
  list
    .map((s) => words(s))
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length);
const set = (list: Iterable<string>) => new Set([...list].map((s) => normalizeText(s).trim()));

const L = {
  list: lex(LIST_INTENT),
  count: lex(COUNT_INTENT),
  open: lex(OPEN_INTENT),
  negation: lex(NEGATIONS),
  fillerPhrases: lex(FILLER_PHRASES),
  noAllergy: lex(NO_ALLERGY_PHRASES),
  condition: lex(CONDITION_TRIGGERS),
  medication: lex(MEDICATION_TRIGGERS),
  on: lex(ON_TRIGGERS),
  procedure: lex(PROCEDURE_TRIGGERS),
  has: lex(HAS_TRIGGERS),
  tag: lex(TAG_TRIGGERS),
  appointment: lex(APPOINTMENT_WORDS),
  visit: lex(VISIT_WORDS),
  doctorLinks: lex(DOCTOR_LINKS),
  details: DETAIL_PHRASES.map((d) => ({ words: words(d.phrase), detail: d.detail })).sort((a, b) => b.words.length - a.words.length),
};

const ALLERGY = set(ALLERGY_WORDS);
const ALLERGY_PREP = set(ALLERGY_PREPOSITIONS);
const FILLER = set(FILLERS);
const DOCTOR_TITLE = set(DOCTOR_TITLES);
const NEGATED_HAS_SET = set(NEGATED_HAS);
const NEGATED_TAKES_SET = set(NEGATED_TAKES);
const PROCEDURE_WORD = set(PROCEDURE_WORDS);
const SEX = new Map(Object.entries(SEX_WORDS).map(([k, v]) => [normalizeText(k), v] as const));
const MONTH = new Map(Object.entries(MONTHS).map(([k, v]) => [normalizeText(k), v] as const));
const NUMBER_WORD = new Map(Object.entries(NUMBER_WORDS).map(([k, v]) => [normalizeText(k), v] as const));
const UNIT = new Map(Object.entries(DURATION_UNITS).map(([k, v]) => [normalizeText(k), v] as const));
const TRANSLIT = new Map(Object.entries(NAME_TRANSLITERATIONS).map(([k, v]) => [normalizeText(k), v] as const));

const OR_WORDS = set(["or", "either", "او", "ولا", "/"]);
const AND_WORDS = set(["and", "&", "plus", "و", "وكمان"]);
const STRENGTH_UNITS = set(["mg", "mcg", "µg", "g", "ml", "iu", "units", "unit", "%", "ملجم", "مجم", "مللي", "ملي", "جم", "مليجرام"]);
const AGE_UNITS = set(["years", "year", "yrs", "yr", "y", "yo", "old", "سنه", "سنين", "عام", "اعوام"]);
/** Skipped at the start of an argument ("allergy to A penicillin", "with ANY known allergy"). */
const ARG_SKIP = set(["a", "an", "the", "any", "known", "documented", "recorded", "current", "currently", "active", "their", "his", "her", "some", "confirmed", "reported", "ال", "اي"]);
/** Verbs and pronouns that end an argument ("with acne WHO are on …"). */
const STOP = set([
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "who", "whom", "which", "that", "whose",
  "where", "when", "with", "without", "but", "since", "over", "under", "above", "below", "between", "aged", "older", "younger", "than",
  "for", "in", "at", "from", "by", "on", "taking", "using", "not", "no", "and", "or", "prescribed", "currently", "also", "who's",
  "اللي", "الي", "الذين", "التي", "الذي", "عنده", "عندها", "عندهم", "بياخد", "بياخدوا", "بتاخد", "ياخد", "واخد", "على", "علي", "مع",
  "من", "فوق", "تحت", "بين", "اكبر", "اصغر", "اقل", "اكتر", "اكثر", "مش", "بدون", "و", "او", "ولا", "هل", "في", "عن",
]);
const NARRATIVE = lex([
  "summarise", "summarize", "summary", "compare", "explain", "describe", "review", "draft", "write", "tell me about", "outline",
  "لخص", "لخصلي", "ملخص", "قارن", "اشرح", "اكتب", "احكيلي", "احكي",
]);
/** Words that start a time limit; left unused they are reported, never dropped. */
const TIME_START = set(["today", "tonight", "tomorrow", "yesterday", "since", "ago", "recently", "lately", "النهارده", "انهارده", "امبارح", "بكره", "منذ", "مؤخرا"]);
const LEADING_SKIP = set(["please", "ok", "okay", "so", "hi", "hey", "hello", "and", "also", "now", "then", "dr", "doctor", "يا", "لو", "طيب", "ممكن", "بس"]);
const CHECK_OPENERS = set(["is", "are", "was", "were", "does", "do", "did", "has", "have", "had", "can", "could", "هل"]);

/** Every word the lexicons use: never treated as a typo of a drug or condition, nor as a patient name. */
const KEYWORDS = new Set<string>([
  ...FILLER,
  ...ALLERGY,
  ...DOCTOR_TITLE,
  ...SEX.keys(),
  ...MONTH.keys(),
  ...NUMBER_WORD.keys(),
  ...UNIT.keys(),
  ...STOP,
  ...[L.list, L.count, L.open, L.negation, L.condition, L.medication, L.on, L.procedure, L.has, L.tag, L.appointment, L.visit].flat(2),
  ...set(["later", "water", "other", "after", "never", "under", "patients", "patient", "allergy", "allergies", "today", "tomorrow", "week", "month", "year", "upcoming", "next", "last", "ago", "since", "before"]),
]);

// ── Vocabulary phrases ───────────────────────────────────────────────────────

interface VocabPhrase {
  words: string[];
  conceptId: string | null;
  classId: string | null;
  kind: ConceptKind | "class";
  label: string;
}

const STATIC_VOCAB: VocabPhrase[] = [
  ...CONCEPTS.flatMap((c) =>
    c.names.map((name) => ({ words: words(name), conceptId: c.id, classId: null, kind: c.kind, label: c.label }) satisfies VocabPhrase),
  ),
  ...DRUG_CLASSES.flatMap((c) =>
    c.names.map((name) => ({ words: words(name), conceptId: null, classId: c.id, kind: "class" as const, label: c.label }) satisfies VocabPhrase),
  ),
].filter((v) => v.words.length > 0);

const MED_FORM_WORDS = set([
  "cream", "gel", "solution", "tablet", "tablets", "tab", "tabs", "capsule", "capsules", "caps", "spray", "lotion", "shampoo", "foam",
  "ointment", "serum", "wash", "plaster", "drops", "injection", "injections", "intralesional", "topical", "oral", "thin", "layer", "sachet",
  "syrup", "suspension", "patch", "mg", "mcg", "g", "ml", "iu", "units", "unit", "kit", "pack", "vial", "ampoule", "amp", "%",
]);

/** The drug part of a recorded medication name ("Minoxidil 5% solution" → "minoxidil"). */
export function medicationBaseName(name: string): string[] {
  return words(name).filter((w) => !/^\d/.test(w) && !MED_FORM_WORDS.has(w));
}

/** Shape of an unlisted drug name (generic-name suffixes), for "on <x>" questions. */
const DRUG_SHAPE = /(?:cillin|mycin|cycline|oxacin|azole|olol|pril|sartan|statin|vir|mab|nib|tinib|parin|xaban|gliptin|formin|lone|sone|zine|dine|tidine|prazole|fen|profen|caine|ide|ine|ate|one|il|ol)$/;

interface TermHit {
  start: number;
  end: number;
  conceptId: string | null;
  classId: string | null;
  kind: ConceptKind | "class";
  label: string;
  input: string;
  fuzzy: boolean;
  andPrefix: boolean;
  strength: string | null;
}

type Role = "detail" | "filler" | "crit" | "intent" | "conn" | "neg" | "problem";

interface Chunk {
  tokens: number[];
  hit: TermHit | null;
  text: string;
  strength: string | null;
}

interface Argument {
  chunks: Chunk[];
  connectors: ("or" | "and")[];
  /** Token indices consumed (chunk tokens, connectors and skipped articles). */
  used: number[];
  end: number;
}

// ── Parser ───────────────────────────────────────────────────────────────────

export function parseCohortQuestion(question: string, ctx: ParseContext = {}): ParsedQuestion {
  return new Parser(question, ctx).run();
}

class Parser {
  private readonly t: Token[];
  private readonly n: number;
  private readonly claim: (Role | null)[];
  private readonly hits: TermHit[] = [];
  private readonly hitAt = new Map<number, TermHit>();
  private readonly inHit: (TermHit | null)[];
  private readonly criteria: Criterion[] = [];
  private readonly problems: ParseProblem[] = [];
  private readonly details = new Set<Detail>();
  private readonly now: Date;
  private readonly tz: string;
  private readonly vocab: VocabPhrase[];
  private readonly tenantMeds: string[][];

  constructor(
    private readonly question: string,
    private readonly ctx: ParseContext,
  ) {
    this.t = tokenize(question.slice(0, 2000));
    this.n = this.t.length;
    this.claim = new Array<Role | null>(this.n).fill(null);
    this.inHit = new Array<TermHit | null>(this.n).fill(null);
    this.now = ctx.now ?? new Date();
    this.tz = ctx.timeZone ?? "Africa/Cairo";
    this.tenantMeds = [...new Set((ctx.medicationNames ?? []).map((m) => medicationBaseName(m).join(" ")).filter(Boolean))].map((m) => m.split(" "));
    const known = new Set(STATIC_VOCAB.map((v) => v.words.join(" ")));
    this.vocab = [
      ...STATIC_VOCAB,
      ...this.tenantMeds
        .filter((w) => !known.has(w.join(" ")))
        .map((w) => ({ words: w, conceptId: null, classId: null, kind: "drug" as const, label: w.join(" ") })),
    ];
  }

  run(): ParsedQuestion {
    this.markDetails();
    this.markFillerPhrases();
    this.markTerms();
    this.markNoAllergy();
    this.markDoctors();
    this.markSex();
    this.markAges();
    this.markVisits();
    this.markAppointments();
    this.markAllergies();
    this.markTriggered(L.condition, "condition");
    this.markTriggered(L.medication, "medication");
    this.markOn();
    this.markTriggered(L.procedure, "procedure");
    this.markTags();
    this.markHas();
    this.markBareTerms();
    this.markBareTags();
    const intent = this.markIntent();
    this.mergeAndCheckConnectors();
    this.checkDanglingNegations();
    this.checkDanglingTime();
    const leftover = this.leftover();
    const subject = this.subject(intent, leftover);
    this.criteria.sort((a, b) => a.span[0] - b.span[0]);
    return {
      question: this.question,
      language: isMostlyArabic(this.question) ? "ar" : "en",
      intent,
      criteria: this.criteria,
      details: [...this.details],
      leftover,
      problems: this.problems,
      subject,
      narrative: this.isNarrative(),
      tokens: this.t,
    };
  }

  // ── token helpers ─────────────────────────────────────────────────────────

  private word(i: number): string | null {
    const tok = this.t[i];
    return tok && (tok.kind === "word" || tok.kind === "number") ? tok.norm : null;
  }

  private free(i: number): boolean {
    return i >= 0 && i < this.n && this.claim[i] === null;
  }

  private take(from: number, to: number, role: Role): void {
    for (let i = Math.max(0, from); i < Math.min(this.n, to); i++) if (this.claim[i] === null) this.claim[i] = role;
  }

  private takeList(indices: number[], role: Role): void {
    for (const i of indices) if (this.claim[i] === null) this.claim[i] = role;
  }

  private raw(from: number, to: number): string {
    return tidy(
      this.t
        .slice(from, to)
        .map((tok) => tok.raw)
        .join(" ")
        .replace(/\s+([,.?!؟،])/g, "$1"),
    );
  }

  private rawOf(indices: number[]): string {
    if (!indices.length) return "";
    return this.raw(Math.min(...indices), Math.max(...indices) + 1);
  }

  /** Longest lexicon phrase starting at `i` on unclaimed tokens; returns its end (exclusive) or -1. */
  private matchLex(i: number, phrases: Lex, opts: { allowClaimed?: boolean } = {}): number {
    for (const phrase of phrases) {
      const end = this.matchPhrase(i, phrase, opts);
      if (end !== -1) return end;
    }
    return -1;
  }

  private matchPhrase(i: number, phrase: string[], opts: { allowClaimed?: boolean } = {}): number {
    let j = i;
    for (const w of phrase) {
      const tok = this.word(j);
      if (tok === null) return -1;
      if (!opts.allowClaimed && this.claim[j] !== null) return -1;
      if (!keywordEq(tok, w)) return -1;
      j++;
    }
    return j;
  }

  private numberAt(i: number): number | null {
    const tok = this.t[i];
    if (!tok) return null;
    if (tok.kind === "number") {
      const v = Number(tok.norm.replace("%", ""));
      return Number.isFinite(v) ? v : null;
    }
    if (tok.kind === "word") {
      const v = NUMBER_WORD.get(tok.norm);
      return v ?? null;
    }
    return null;
  }

  /** Skip claimed filler tokens and articles going backwards; returns the index of the next meaningful token. */
  private prevMeaningful(i: number, skip: Set<string> = ARG_SKIP): number {
    let j = i;
    while (j >= 0) {
      const w = this.word(j);
      if (this.claim[j] === "filler" || this.claim[j] === "intent") {
        j--;
        continue;
      }
      if (w !== null && this.claim[j] === null && (skip.has(w) || ["are", "is", "were", "was", "be", "been", "do", "does", "did", "currently", "who", "that"].includes(w))) {
        j--;
        continue;
      }
      return j;
    }
    return -1;
  }

  /** A negation within the three meaningful tokens before `i` (claimed as part of the criterion). */
  private negationBefore(i: number): number[] | null {
    let j = i - 1;
    let steps = 0;
    while (j >= 0 && steps < 4) {
      if (this.claim[j] !== null && this.claim[j] !== "filler") return null;
      const w = this.word(j);
      if (w === null) return null;
      for (const phrase of L.negation) {
        const start = j - phrase.length + 1;
        if (start < 0) continue;
        if (this.matchPhrase(start, phrase) === j + 1) {
          const out: number[] = [];
          for (let k = start; k <= j; k++) out.push(k);
          return out;
        }
      }
      if (!ARG_SKIP.has(w) && !["are", "is", "were", "was", "do", "does", "did", "have", "has", "had", "who", "that", "currently", "been", "being", "yet", "ever", "still"].includes(w)) return null;
      j--;
      steps++;
    }
    return null;
  }

  // ── passes ────────────────────────────────────────────────────────────────

  private markDetails(): void {
    for (let i = 0; i < this.n; i++) {
      for (const d of L.details) {
        const end = this.matchPhrase(i, d.words);
        if (end !== -1) {
          this.take(i, end, "detail");
          this.details.add(d.detail);
          break;
        }
      }
    }
  }

  private markFillerPhrases(): void {
    for (let i = 0; i < this.n; i++) {
      const end = this.matchLex(i, L.fillerPhrases);
      if (end !== -1) this.take(i, end, "filler");
    }
  }

  private markTerms(): void {
    for (let i = 0; i < this.n; i++) {
      if (this.claim[i] !== null || this.t[i]?.kind !== "word") continue;
      let best: { vp: VocabPhrase; end: number; quality: number; andPrefix: boolean } | null = null;
      for (const vp of this.vocab) {
        const m = this.matchVocab(i, vp.words);
        if (!m) continue;
        const len = m.end - i;
        const bestLen = best ? best.end - i : -1;
        if (
          !best ||
          len > bestLen ||
          (len === bestLen && m.quality > best.quality) ||
          (len === bestLen && m.quality === best.quality && best.vp.kind === "class" && vp.kind !== "class")
        ) {
          best = { vp, end: m.end, quality: m.quality, andPrefix: m.andPrefix };
        }
      }
      if (!best) continue;
      const hit: TermHit = {
        start: i,
        end: best.end,
        conceptId: best.vp.conceptId,
        classId: best.vp.classId,
        kind: best.vp.kind,
        label: best.vp.label,
        input: displayInput(this.raw(i, best.end), best.andPrefix),
        fuzzy: best.quality === 1,
        andPrefix: best.andPrefix,
        strength: null,
      };
      if (hit.kind === "drug" || hit.kind === "class") this.absorbStrength(hit);
      this.hits.push(hit);
      this.hitAt.set(hit.start, hit);
      for (let k = hit.start; k < hit.end; k++) this.inHit[k] = hit;
      i = hit.end - 1;
    }
  }

  private matchVocab(i: number, phrase: string[]): { end: number; quality: number; andPrefix: boolean } | null {
    let quality = 3;
    let andPrefix = false;
    for (let k = 0; k < phrase.length; k++) {
      const j = i + k;
      const tok = this.word(j);
      if (tok === null || this.claim[j] !== null) return null;
      const w = phrase[k]!;
      if (tok === w) continue;
      if (sameWordExact(tok, w)) {
        quality = Math.min(quality, 2);
        if (k === 0 && isArabic(tok) && tok.startsWith("و") && !w.startsWith("و") && sameWordExact(tok.slice(1), w)) andPrefix = true;
        continue;
      }
      if (canBeTypo(tok) && sameWord(tok, w)) {
        quality = 1;
        continue;
      }
      return null;
    }
    // A one-letter-different short word is not a match ("later" ≠ "laser").
    if (quality === 1 && phrase.length === 1 && KEYWORDS.has(phrase[0]!)) return null;
    return { end: i + phrase.length, quality, andPrefix };
  }

  private absorbStrength(hit: TermHit): void {
    const tok = this.t[hit.end];
    if (!tok || tok.kind !== "number" || this.claim[hit.end] !== null) return;
    const unit = this.word(hit.end + 1);
    if (tok.norm.endsWith("%")) {
      hit.strength = tok.norm;
      hit.end += 1;
      return;
    }
    if (unit && STRENGTH_UNITS.has(unit)) {
      hit.strength = `${tok.norm} ${unit === "%" ? "%" : unit}`.replace(" %", "%");
      hit.end += 2;
      return;
    }
    if (unit && AGE_UNITS.has(unit)) return;
    const value = Number(tok.norm);
    if (Number.isFinite(value) && value > 0 && value <= 2000) {
      hit.strength = tok.norm;
      hit.end += 1;
    }
  }

  private markNoAllergy(): void {
    for (let i = 0; i < this.n; i++) {
      const end = this.matchLex(i, L.noAllergy);
      if (end === -1) continue;
      this.addCriterion({
        kind: "allergy",
        negate: true,
        match: "any",
        terms: [anyTerm()],
        source: this.raw(i, end),
        span: [i, end - 1],
      });
      this.take(i, end, "crit");
      i = end - 1;
    }
  }

  private markDoctors(): void {
    const doctors = (this.ctx.doctors ?? []).map((d) => ({ ...d, words: doctorNameWords(d.name) }));
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const w = this.word(i);
      let nameStart = -1;
      let explicitTitle = false;
      if (w !== null && DOCTOR_TITLE.has(w)) {
        nameStart = i + 1;
        if (this.t[nameStart]?.kind === "punct" && this.t[nameStart]?.norm === ".") nameStart++;
        explicitTitle = w === "dr" || w === "د";
      } else {
        // "seen by Omar Fahmy", "patients of Mariam Tarek": a link phrase followed by a doctor's name.
        const linkEnd = this.matchLex(i, L.doctorLinks);
        if (linkEnd === -1 || !doctors.length) continue;
        const probe = this.matchDoctorAt(linkEnd, doctors);
        if (!probe || probe.matched < 2) continue;
        nameStart = linkEnd;
      }
      if (!doctors.length && !explicitTitle) continue;
      const found = this.matchDoctorAt(nameStart, doctors);
      if (!found) {
        if (explicitTitle) {
          const end = Math.min(this.n, nameStart + (this.word(nameStart + 1) && !KEYWORDS.has(this.word(nameStart + 1)!) ? 2 : 1));
          const text = this.raw(i, end);
          this.problems.push({ text, reason: "no clinician of this clinic has that name" });
          this.take(i, end, "problem");
        }
        continue;
      }
      if (found.candidates.length > 1) {
        const text = this.raw(i, found.end);
        this.problems.push({
          text,
          reason: `several clinicians match (${found.candidates.map((d) => d.name).join(", ")})`,
        });
        this.take(i, found.end, "problem");
        continue;
      }
      // Link words just before the title ("patients of", "seen by", "مع", "عند").
      let start = i;
      for (const link of L.doctorLinks) {
        const s = i - link.length;
        if (s >= 0 && this.matchPhrase(s, link) === i) {
          start = s;
          break;
        }
      }
      const negation = this.negationBefore(start);
      const doctor = found.candidates[0]!;
      this.addCriterion({
        kind: "doctor",
        negate: Boolean(negation),
        match: "any",
        terms: [],
        doctors: [{ id: doctor.id, name: doctor.name }],
        source: this.raw(start, found.end),
        span: [negation?.[0] ?? start, found.end - 1],
      });
      if (negation) this.takeList(negation, "neg");
      this.take(start, found.end, "crit");
      i = found.end - 1;
    }
  }

  private matchDoctorAt(
    start: number,
    doctors: { id: string; name: string; words: string[] }[],
  ): { end: number; matched: number; candidates: { id: string; name: string }[] } | null {
    let best: { end: number; matched: number; candidates: { id: string; name: string }[] } | null = null;
    for (let len = 3; len >= 1; len--) {
      const qWords: string[] = [];
      for (let k = 0; k < len; k++) {
        const w = this.word(start + k);
        if (w === null || !this.free(start + k) || this.t[start + k]?.kind !== "word") break;
        qWords.push(w);
      }
      if (qWords.length !== len) continue;
      const candidates = doctors.filter((d) => qWords.every((q) => d.words.some((dw) => nameEq(q, dw))));
      if (candidates.length) {
        best = { end: start + len, matched: len, candidates: candidates.map((d) => ({ id: d.id, name: d.name })) };
        break;
      }
    }
    return best;
  }

  private markSex(): void {
    const sexes: { i: number; sex: Sex }[] = [];
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i) || this.inHit[i]) continue;
      const w = this.word(i);
      if (w === null) continue;
      const sex = SEX.get(w);
      if (sex) sexes.push({ i, sex });
    }
    if (!sexes.length) return;
    const distinct = [...new Set(sexes.map((s) => s.sex))].sort();
    for (const s of sexes) this.claim[s.i] = "crit";
    // "men and women" asks for both; that filters nothing but other/undisclosed.
    this.addCriterion({
      kind: "sex",
      negate: false,
      match: "any",
      terms: [],
      sexes: distinct,
      source: sexes.map((s) => this.t[s.i]!.raw).join(", "),
      span: [sexes[0]!.i, sexes[sexes.length - 1]!.i],
    });
  }

  // ── age ─────────────────────────────────────────────────────────────────

  private markAges(): void {
    const found: { min: number | null; max: number | null; text: string; start: number; end: number }[] = [];
    const GT = lex(["over", "above", "older than", "more than", "greater than", "aged over", "age over", "over the age of", "older then", ">", "فوق", "اكبر من", "اكتر من", "اكثر من", "سنهم فوق", "عمرهم فوق", "عمره فوق", "سنه فوق", "سنهم اكبر من", "عمرهم اكبر من"]);
    const GTE = lex(["at least", "aged at least", ">=", "minimum age", "من سن"]);
    const LT = lex(["under", "below", "younger than", "less than", "aged under", "under the age of", "younger then", "<", "تحت", "اقل من", "اصغر من", "سنهم تحت", "عمرهم تحت", "عمره تحت", "سنهم اقل من", "عمرهم اقل من"]);
    const LTE = lex(["at most", "<=", "up to", "aged up to"]);
    const BETWEEN = lex(["between", "aged between", "between the ages of", "aged", "ages", "from", "بين", "من", "سنهم بين", "عمرهم بين", "اعمارهم بين"]);
    const EXACT = lex(["aged", "age", "عمره", "عمرهم", "سنه", "سنهم", "عمرها", "سنها"]);
    const GTE_SUFFIX = lex(["and over", "and above", "or older", "or over", "or more", "or above", "and older", "years and older", "years or older", "years and over", "+", "plus", "فما فوق", "وما فوق", "او اكبر", "و اكبر", "واكثر"]);
    const LTE_SUFFIX = lex(["or younger", "and under", "or less", "and below", "or under", "and younger", "years or younger", "years and under", "او اقل", "او اصغر", "فاقل"]);
    const GROUPS: { phrase: string[]; min: number | null; max: number | null; text: string }[] = [
      ...["children", "child", "kids", "kid", "minors", "minor", "paediatric", "pediatric", "under-18s", "اطفال", "الاطفال", "طفل", "قصر"].map((p) => ({ phrase: words(p), min: null, max: 17, text: "children (under 18)" })),
      ...["teenagers", "teens", "teenager", "adolescents", "adolescent", "مراهقين", "المراهقين"].map((p) => ({ phrase: words(p), min: 13, max: 19, text: "teenagers (13 to 19)" })),
      ...["adults", "adult", "بالغين", "البالغين"].map((p) => ({ phrase: words(p), min: 18, max: null, text: "adults (18 or older)" })),
      ...["elderly", "seniors", "senior", "older adults", "older patients", "كبار السن", "مسنين", "المسنين"].map((p) => ({ phrase: words(p), min: 65, max: null, text: "elderly (65 or older)" })),
    ].sort((a, b) => b.phrase.length - a.phrase.length);
    const DECADES: Record<string, number> = { twenties: 20, thirties: 30, forties: 40, fifties: 50, sixties: 60, seventies: 70, eighties: 80, العشرينات: 20, الثلاثينات: 30, الاربعينات: 40, الخمسينات: 50, الستينات: 60 };

    const age = (i: number): number | null => {
      const v = this.numberAt(i);
      return v !== null && Number.isInteger(v) && v >= 0 && v <= 120 && this.free(i) ? v : null;
    };
    const skipUnits = (j: number): number => {
      let k = j;
      while (this.free(k) && this.word(k) !== null && AGE_UNITS.has(this.word(k)!)) k++;
      if (this.word(k) === "of" && this.word(k + 1) === "age") k += 2;
      return k;
    };

    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      // groups ("children", "elderly")
      let matched = false;
      for (const g of GROUPS) {
        const end = this.matchPhrase(i, g.phrase);
        if (end !== -1) {
          found.push({ min: g.min, max: g.max, text: g.text, start: i, end });
          this.take(i, end, "crit");
          i = end - 1;
          matched = true;
          break;
        }
      }
      if (matched) continue;
      // decades ("in their 30s", "in their thirties")
      if (this.word(i) === "in" && this.word(i + 1) === "their") {
        const v = age(i + 2);
        const decadeWord = this.word(i + 2);
        if (v !== null && v % 10 === 0 && this.word(i + 3) === "s") {
          found.push({ min: v, max: v + 9, text: `in their ${v}s (${v} to ${v + 9})`, start: i, end: i + 4 });
          this.take(i, i + 4, "crit");
          continue;
        }
        if (decadeWord && DECADES[decadeWord] !== undefined) {
          const d = DECADES[decadeWord]!;
          found.push({ min: d, max: d + 9, text: `in their ${d}s (${d} to ${d + 9})`, start: i, end: i + 3 });
          this.take(i, i + 3, "crit");
          continue;
        }
      }
      // between N and M
      for (const phrase of BETWEEN) {
        const end = this.matchPhrase(i, phrase);
        if (end === -1) continue;
        const a = age(end);
        if (a === null) continue;
        let j = skipUnits(end + 1);
        const conn = this.word(j);
        if (conn && ["and", "to", "-", "و", "الى", "ل", "لحد", "لغايه", "till", "until", "through"].includes(conn)) j++;
        else if (this.t[j]?.kind === "symbol" && this.t[j]?.norm === "-") j++;
        const b = age(j);
        if (b === null) continue;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const stop = skipUnits(j + 1);
        found.push({ min: lo, max: hi, text: `${lo} to ${hi}`, start: i, end: stop });
        this.take(i, stop, "crit");
        matched = true;
        break;
      }
      if (matched) continue;
      // prefix comparisons
      const tryPrefix = (phrases: Lex, make: (v: number) => { min: number | null; max: number | null; text: string }): boolean => {
        for (const phrase of phrases) {
          const end = this.matchPhrase(i, phrase);
          if (end === -1) continue;
          const v = age(end);
          if (v === null) continue;
          const stop = skipUnits(end + 1);
          found.push({ ...make(v), start: i, end: stop });
          this.take(i, stop, "crit");
          return true;
        }
        return false;
      };
      if (tryPrefix(GT, (v) => ({ min: v + 1, max: null, text: `over ${v} (${v + 1} or older)` }))) continue;
      if (tryPrefix(GTE, (v) => ({ min: v, max: null, text: `${v} or older` }))) continue;
      if (tryPrefix(LT, (v) => ({ min: null, max: v - 1, text: `under ${v} (${v - 1} or younger)` }))) continue;
      if (tryPrefix(LTE, (v) => ({ min: null, max: v, text: `${v} or younger` }))) continue;
      // N suffix ("40 and over", "40+", "45 years old")
      const v = age(i);
      if (v !== null) {
        const afterUnits = skipUnits(i + 1);
        const gte = this.matchLex(afterUnits, GTE_SUFFIX);
        if (gte !== -1) {
          found.push({ min: v, max: null, text: `${v} or older`, start: i, end: gte });
          this.take(i, gte, "crit");
          continue;
        }
        const plus = this.t[i + 1];
        if (plus?.kind === "symbol" && plus.norm === "+") {
          found.push({ min: v, max: null, text: `${v} or older`, start: i, end: i + 2 });
          this.take(i, i + 2, "crit");
          continue;
        }
        const lte = this.matchLex(afterUnits, LTE_SUFFIX);
        if (lte !== -1) {
          found.push({ min: null, max: v, text: `${v} or younger`, start: i, end: lte });
          this.take(i, lte, "crit");
          continue;
        }
        // "45 years old", "45-year-old", "45 yo"
        const unitWords: string[] = [];
        for (let k = i + 1; k < afterUnits; k++) unitWords.push(this.word(k) ?? "");
        if (unitWords.length && (unitWords.includes("old") || unitWords.includes("yo") || unitWords.includes("سنه") || unitWords.includes("سنين") || unitWords.includes("years"))) {
          const prev = this.word(i - 1);
          if (prev === null || !["for", "in", "since", "ago", "من", "منذ", "بقاله", "last", "past"].includes(prev)) {
            found.push({ min: v, max: v, text: `${v}`, start: i, end: afterUnits });
            this.take(i, afterUnits, "crit");
            continue;
          }
        }
      }
      // "aged 45", "عمره 45"
      for (const phrase of EXACT) {
        const end = this.matchPhrase(i, phrase);
        if (end === -1) continue;
        const a = age(end);
        if (a === null) continue;
        const stop = skipUnits(end + 1);
        found.push({ min: a, max: a, text: `${a}`, start: i, end: stop });
        this.take(i, stop, "crit");
        break;
      }
    }
    if (!found.length) return;
    let min: number | null = null;
    let max: number | null = null;
    for (const f of found) {
      if (f.min !== null) min = min === null ? f.min : Math.max(min, f.min);
      if (f.max !== null) max = max === null ? f.max : Math.min(max, f.max);
    }
    const text = found.length === 1 ? found[0]!.text : `${min ?? 0} to ${max ?? "any"}`;
    const first = found[0]!;
    const negation = this.negationBefore(first.start);
    if (negation) {
      // "not over 40" is not supported: say so rather than invert it silently.
      this.problems.push({ text: this.raw(negation[0]!, first.end), reason: "a negated age range is not supported" });
      this.takeList(negation, "problem");
      return;
    }
    this.addCriterion({
      kind: "age",
      negate: false,
      match: "all",
      terms: [],
      age: { min, max, text },
      source: found.map((f) => this.raw(f.start, f.end)).join(", "),
      span: [first.start, found[found.length - 1]!.end - 1],
    });
  }

  // ── time phrases ─────────────────────────────────────────────────────────

  /** A point in the past at `i` ("since March", "in the last 6 months", "منذ شهرين"). */
  private pastPoint(i: number): { at: Date | null; label: string; end: number } | null {
    let j = i;
    const lead = ["since", "in", "for", "over", "within", "during", "the", "last", "past", "من", "منذ", "بقاله", "بقالهم", "بقالها", "خلال", "اخر", "قبل", "before", "prior", "to", "than", "more", "ago"];
    let sawSince = false;
    let sawBefore = false;
    while (j < this.n && this.free(j) && lead.includes(this.word(j) ?? "")) {
      if (this.word(j) === "since" || this.word(j) === "منذ") sawSince = true;
      if (this.word(j) === "before" || this.word(j) === "prior" || this.word(j) === "قبل") sawBefore = true;
      j++;
    }
    // "last year", "this year"
    if (this.word(j) === "year" && ["last", "past"].includes(this.word(j - 1) ?? "") && !(this.numberAt(j - 2) !== null)) {
      return { at: addDays(startOfDayInTz(this.now, this.tz), -365, this.tz), label: "the last year", end: j + 1 };
    }
    // explicit date: yyyy-mm-dd, d-m-yyyy, month [year]
    const a = this.numberAt(j);
    if (a !== null && this.t[j + 1]?.norm === "-" && this.numberAt(j + 2) !== null && this.t[j + 3]?.norm === "-" && this.numberAt(j + 4) !== null) {
      const b = this.numberAt(j + 2)!;
      const c = this.numberAt(j + 4)!;
      const [y, m, d] = a > 1900 ? [a, b, c] : [c < 100 ? 2000 + c : c, b, a];
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        const at = zonedTimeToUtc({ year: y, month: m, day: d }, this.tz);
        return { at, label: dateKeyInTz(at, this.tz), end: j + 5 };
      }
    }
    const monthWord = this.word(j);
    if (monthWord && MONTH.has(monthWord) && (sawSince || sawBefore || j > i)) {
      const month = MONTH.get(monthWord)!;
      const p = zonedParts(this.now, this.tz);
      let year = p.month >= month ? p.year : p.year - 1;
      let end = j + 1;
      const y = this.numberAt(j + 1);
      if (y !== null && y > 1900 && y < 2100) {
        year = y;
        end = j + 2;
      }
      const at = zonedTimeToUtc({ year, month, day: 1 }, this.tz);
      return { at, label: dateKeyInTz(at, this.tz), end };
    }
    // duration: [N] unit [ago]
    let count: number | null = this.numberAt(j);
    let k = j;
    if (count !== null) k++;
    const unitWord = this.word(k);
    const unit = unitWord ? UNIT.get(unitWord) : undefined;
    if (unit) {
      if (count === null) count = unit.count ?? 1;
      else if (unit.count) count = count * unit.count;
      let end = k + 1;
      if (this.word(end) === "ago") end++;
      if (count <= 0 || count > 50) return null;
      const days = Math.round(count * unit.days);
      const at = addDays(startOfDayInTz(this.now, this.tz), -days, this.tz);
      const unitLabel = unit.days === 1 ? "day" : unit.days === 7 ? "week" : unit.days === 30 ? "month" : "year";
      return { at, label: `${dateKeyInTz(at, this.tz)} (${count} ${unitLabel}${count === 1 ? "" : "s"})`, end };
    }
    return null;
  }

  private markVisits(): void {
    const AR_NEG_VISIT = set(["مجاش", "ماجاش", "مجوش", "ماجوش", "مجتش", "ماجتش", "مزارش", "مازارش", "مزاروش", "مازاروش", "محضرش", "ماحضرش", "متشافش", "ماتشافش", "مشفناهوش", "ماشفناهوش", "مشفناهاش"]);
    const LAST_VISIT = lex(["last visit", "last visited", "last seen", "last came", "last appointment", "last attended", "اخر زياره", "اخر مره جه", "اخر مره جت", "اخر ميعاد"]);
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const w = this.word(i);
      if (w === null) continue;
      // Arabic negated "came/visited" verbs: "مجاش من 3 شهور"
      if (AR_NEG_VISIT.has(w) || (w === "لم" && ["يزر", "يزوروا", "يحضر", "يحضروا", "ياتي", "ياتوا"].includes(this.word(i + 1) ?? ""))) {
        const verbEnd = w === "لم" ? i + 2 : i + 1;
        const point = this.pastPoint(this.skipFiller(verbEnd, ["العياده", "للعياده", "عندنا"]));
        const cutoff = point ? { before: point.at!.toISOString(), label: `no visit since ${point.label}` } : { before: null, label: "no visit on record" };
        const end = point ? point.end : verbEnd;
        this.addCriterion({ kind: "lastVisit", negate: false, match: "all", terms: [], cutoff, source: this.raw(i, end), span: [i, end - 1] });
        this.take(i, end, "crit");
        i = end - 1;
        continue;
      }
      // "last visit before March", "last seen more than 6 months ago", "اخر زياره من 3 شهور"
      const lastEnd = this.matchLex(i, LAST_VISIT);
      if (lastEnd !== -1) {
        let j = lastEnd;
        while (this.free(j) && ["was", "is", "were", "more", "than", "over", "longer", "at", "least", "له", "لهم", "ليه", "ليهم", "كانت", "كان", "اكتر", "من"].includes(this.word(j) ?? "") && !(this.word(j) === "من" && this.numberAt(j + 1) === null && !UNIT.has(this.word(j + 1) ?? ""))) j++;
        const point = this.pastPoint(j);
        if (point?.at) {
          const cutoff = { before: point.at.toISOString(), label: `no visit since ${point.label}` };
          this.addCriterion({ kind: "lastVisit", negate: false, match: "all", terms: [], cutoff, source: this.raw(i, point.end), span: [i, point.end - 1] });
          this.take(i, point.end, "crit");
          i = point.end - 1;
        }
        continue;
      }
      // "no visit since …", "not seen in 6 months", "haven't visited for a year", "never visited"
      const visitEnd = this.matchLex(i, L.visit);
      if (visitEnd === -1) continue;
      const negation = this.negationBefore(i);
      if (!negation) continue;
      let j = visitEnd;
      while (this.free(j) && ["the", "clinic", "us", "back", "again", "here", "a", "any", "العياده", "عندنا"].includes(this.word(j) ?? "")) j++;
      const point = this.pastPoint(j);
      const never = negation.some((k) => this.word(k) === "never");
      if (!point && !never && !["visit", "visits", "زياره"].includes(this.word(i) ?? "")) continue;
      const cutoff = point?.at ? { before: point.at.toISOString(), label: `no visit since ${point.label}` } : { before: null, label: "no visit on record" };
      const end = point ? point.end : visitEnd;
      const start = negation[0]!;
      // "with no visit" / "who have had no visit": take the verb too.
      this.addCriterion({ kind: "lastVisit", negate: false, match: "all", terms: [], cutoff, source: this.raw(start, end), span: [start, end - 1] });
      this.takeList(negation, "crit");
      this.take(start, end, "crit");
      i = end - 1;
    }
  }

  private skipFiller(j: number, extra: string[] = []): number {
    let k = j;
    while (this.free(k) && extra.includes(this.word(k) ?? "")) k++;
    return k;
  }

  private markAppointments(): void {
    const tz = this.tz;
    const today0 = startOfDayInTz(this.now, tz);
    const windowAt = (i: number): { w: TimeWindow; end: number } | null => {
      const w = this.word(i);
      const w2 = this.word(i + 1);
      if (w === null) return null;
      const make = (from: Date, to: Date | null, label: string, upcomingOnly: boolean, end: number) => ({
        w: { from: from.toISOString(), to: to ? to.toISOString() : null, label, upcomingOnly },
        end,
      });
      if (["today", "tonight", "النهارده", "انهارده", "النهاردة", "اليوم"].includes(w)) return make(today0, endOfDayInTz(this.now, tz), "today", false, i + 1);
      if (["tomorrow", "بكره", "غدا", "باكر"].includes(w)) {
        const d = addDays(today0, 1, tz);
        return make(d, endOfDayInTz(d, tz), "tomorrow", false, i + 1);
      }
      if ((w === "this" && w2 === "week") || (w === "الاسبوع" && ["ده", "دا", "الحالي", "هذا"].includes(w2 ?? ""))) {
        const start = startOfWeekInTz(this.now, tz);
        return make(today0, new Date(addDays(start, 7, tz).getTime() - 1), "this week", false, i + 2);
      }
      if ((w === "next" && w2 === "week") || (w === "الاسبوع" && ["الجاي", "القادم", "اللي", "الجاى"].includes(w2 ?? ""))) {
        const start = addDays(startOfWeekInTz(this.now, tz), 7, tz);
        return make(start, new Date(addDays(start, 7, tz).getTime() - 1), "next week", false, i + 2 + (w2 === "اللي" ? 1 : 0));
      }
      if ((w === "this" && w2 === "month") || (w === "الشهر" && ["ده", "دا", "الحالي"].includes(w2 ?? ""))) {
        const p = zonedParts(this.now, tz);
        return make(today0, new Date(zonedTimeToUtc({ year: p.year, month: p.month + 1, day: 1 }, tz).getTime() - 1), "this month", false, i + 2);
      }
      if ((w === "next" && w2 === "month") || (w === "الشهر" && ["الجاي", "القادم"].includes(w2 ?? ""))) {
        const p = zonedParts(this.now, tz);
        const from = zonedTimeToUtc({ year: p.year, month: p.month + 1, day: 1 }, tz);
        return make(from, new Date(zonedTimeToUtc({ year: p.year, month: p.month + 2, day: 1 }, tz).getTime() - 1), "next month", false, i + 2);
      }
      // "in the next 7 days", "within 2 weeks", "خلال 3 ايام"
      let j = i;
      while (["in", "within", "over", "the", "next", "coming", "خلال", "في"].includes(this.word(j) ?? "")) j++;
      if (j > i) {
        let count = this.numberAt(j);
        let k = j;
        if (count !== null) k++;
        const unit = UNIT.get(this.word(k) ?? "");
        if (unit && unit.days <= 31) {
          if (count === null) count = unit.count ?? 1;
          const days = count * unit.days;
          if (days > 0 && days <= 366) return make(this.now, endOfDayInTz(addDays(this.now, days, tz), tz), `in the next ${days} day${days === 1 ? "" : "s"}`, true, k + 1);
        }
      }
      if (["upcoming", "future", "next", "coming", "جاي", "الجاي", "قادم", "القادم", "جايه", "الجايه"].includes(w)) return make(this.now, null, "upcoming", true, i + 1);
      return null;
    };

    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const apptEnd = this.matchLex(i, L.appointment);
      const comingIn = ["coming", "جايين", "جاي", "جايه"].includes(this.word(i) ?? "") && ["in", "today", "tomorrow", "النهارده", "بكره"].includes(this.word(i + 1) ?? "");
      if (apptEnd === -1 && !comingIn) continue;
      let start = i;
      let end = apptEnd === -1 ? i + 1 : apptEnd;
      if (comingIn && this.word(end) === "in") end++;
      // window before ("upcoming appointment", "today's appointments")
      let window: TimeWindow | null = null;
      for (let back = 1; back <= 2; back++) {
        const s = i - back;
        if (s < 0 || !this.free(s)) break;
        const win = windowAt(s);
        if (win && win.end <= i) {
          window = win.w;
          start = s;
          break;
        }
      }
      // window after ("appointment tomorrow", "booked for next week")
      if (!window) {
        let j = end;
        while (this.free(j) && ["for", "on", "in", "this", "the", "يوم", "في"].includes(this.word(j) ?? "") && !windowAt(j)) j++;
        const win = this.free(j) ? windowAt(j) : null;
        if (win) {
          window = win.w;
          end = win.end;
        }
      }
      if (!window) window = { from: this.now.toISOString(), to: null, label: "upcoming", upcomingOnly: true };
      // the verb and article in front ("with an upcoming appointment", "عندهم ميعاد")
      let s = start - 1;
      while (s >= 0 && this.free(s) && ["a", "an", "any", "the", "booked", "scheduled", "next"].includes(this.word(s) ?? "")) s--;
      const verbEnd = s + 1;
      let verbStart = verbEnd;
      for (const phrase of L.has) {
        const vs = verbEnd - phrase.length;
        if (vs >= 0 && this.matchPhrase(vs, phrase) === verbEnd) {
          verbStart = vs;
          break;
        }
      }
      const negWord = NEGATED_HAS_SET.has(this.word(verbStart - 1) ?? "") ? [verbStart - 1] : null;
      const negation = negWord ?? this.negationBefore(verbStart);
      const from = negation ? negation[0]! : verbStart;
      this.addCriterion({
        kind: "appointment",
        negate: Boolean(negation),
        match: "all",
        terms: [],
        window,
        source: this.raw(from, end),
        span: [from, end - 1],
      });
      if (negation) this.takeList(negation, "crit");
      this.take(from, end, "crit");
      i = end - 1;
    }
  }

  // ── allergies ────────────────────────────────────────────────────────────

  private isAllergyWord(i: number): boolean {
    const w = this.word(i);
    if (w === null || this.t[i]?.kind !== "word") return false;
    if (ALLERGY.has(w)) return true;
    for (const v of variants(w)) if (ALLERGY.has(v)) return true;
    if (w.length >= 6 && /^(?:al+[ae]r|hyper)/.test(w)) {
      for (const a of ALLERGY) if (a[0] === w[0] && editDistance(w, a, 2) <= typoBudget(a.length)) return true;
    }
    return false;
  }

  /** "reaction to penicillin": an allergy when a known drug or allergen follows. */
  private isReactionToTerm(i: number): boolean {
    if (!["reaction", "reactions"].includes(this.word(i) ?? "")) return false;
    const prep = this.word(i + 1);
    if (!prep || !["to", "from", "with"].includes(prep)) return false;
    let j = i + 2;
    while (this.free(j) && ARG_SKIP.has(this.word(j) ?? "")) j++;
    const hit = this.hitAt.get(j);
    return Boolean(hit && hit.kind !== "condition" && hit.kind !== "procedure");
  }

  private markAllergies(): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i) || !(this.isAllergyWord(i) || this.isReactionToTerm(i))) continue;
      // Asthma is written "حساسيه صدر": the vocabulary pass already turned it into a condition.
      let argStart = i + 1;
      if (["reaction", "reactions", "rash"].includes(this.word(argStart) ?? "")) argStart++;
      if (this.free(argStart) && ALLERGY_PREP.has(this.word(argStart) ?? "")) argStart++;
      const forward = this.argument(argStart, "allergy");
      let backward: Argument | null = null;
      if (!forward.chunks.length) backward = this.argumentBackward(i - 1);
      const arg = forward.chunks.length ? forward : backward && backward.chunks.length ? backward : null;
      const start = backward && backward.chunks.length ? Math.min(...backward.used) : i;
      // The has-verb in front ("have an allergy", "عنده حساسيه", "with allergies").
      let s = start - 1;
      while (s >= 0 && this.free(s) && ["a", "an", "any", "known", "documented", "recorded", "drug", "medication"].includes(this.word(s) ?? "")) s--;
      let verbStart = s + 1;
      for (const phrase of L.has) {
        const vs = s + 1 - phrase.length;
        if (vs >= 0 && this.matchPhrase(vs, phrase) === s + 1) {
          verbStart = vs;
          break;
        }
      }
      const negWord = NEGATED_HAS_SET.has(this.word(verbStart - 1) ?? "") && this.free(verbStart - 1) ? [verbStart - 1] : null;
      const negation = negWord ?? this.negationBefore(verbStart);
      const terms = arg ? this.termsFrom(arg.chunks, "allergy") : [anyTerm()];
      const end = arg === forward && forward.chunks.length ? forward.end : i + 1;
      const from = negation ? negation[0]! : verbStart;
      this.addCriterion({
        kind: "allergy",
        negate: Boolean(negation),
        match: arg ? matchOf(arg.connectors) : "any",
        terms,
        source: this.raw(from, end),
        span: [from, end - 1],
      });
      if (negation) this.takeList(negation, "crit");
      this.take(from, i + 1, "crit");
      if (argStart > i + 1) this.take(i + 1, argStart, "crit");
      if (arg) this.takeList(arg.used, "crit");
      if (arg) this.checkMixedConnectors(arg);
      i = Math.max(i, end - 1);
    }
  }

  // ── trigger + argument criteria ──────────────────────────────────────────

  private markTriggered(triggers: Lex, kind: "condition" | "medication" | "procedure"): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const tEnd = this.matchLex(i, triggers);
      if (tEnd === -1) continue;
      const arg = this.argument(tEnd, kind);
      if (!arg.chunks.length) continue;
      const negated = kind === "medication" && NEGATED_TAKES_SET.has(this.word(i) ?? "");
      const negation = negated ? [i] : this.negationBefore(i);
      this.createFromArgument(arg, kind, i, tEnd, negation);
      i = arg.end - 1;
    }
  }

  /** "on X" / "على X": only when X is recognisably a drug. */
  private markOn(): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const tEnd = this.matchLex(i, L.on);
      if (tEnd === -1) continue;
      const arg = this.argument(tEnd, "medication");
      if (!arg.chunks.length) continue;
      const drugLike = arg.chunks.every((c) => (c.hit && (c.hit.kind === "drug" || c.hit.kind === "class")) || (!c.hit && this.looksLikeDrug(c)));
      if (!drugLike) continue;
      const negation = this.negationBefore(i);
      this.createFromArgument(arg, "medication", i, tEnd, negation);
      i = arg.end - 1;
    }
  }

  private looksLikeDrug(c: Chunk): boolean {
    const ws = c.tokens.map((k) => this.word(k) ?? "").filter(Boolean);
    if (ws.length !== 1) return false;
    const w = ws[0]!;
    if (KEYWORDS.has(w) || isArabic(w) || w.length < 5) return false;
    return DRUG_SHAPE.test(w);
  }

  private markTags(): void {
    const tags = this.ctx.tags ?? [];
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      let tEnd = this.matchLex(i, L.tag);
      const hash = this.t[i]?.kind === "symbol" && this.t[i]?.norm === "#";
      if (tEnd === -1 && !hash) continue;
      if (hash) tEnd = i + 1;
      // the tag: up to three words ("new patient", "hair-transplant")
      let j = tEnd;
      if (["as", "the", "a", "an"].includes(this.word(j) ?? "")) j++;
      const tagWords: number[] = [];
      while (tagWords.length < 3 && this.free(j) && this.t[j]?.kind === "word" && !STOP.has(this.word(j)!) && !(tagWords.length && FILLER.has(this.word(j)!))) {
        tagWords.push(j);
        j++;
      }
      // "with the vip tag": the tag word comes before "tag"
      if (!tagWords.length) continue;
      const typed = tagWords.map((k) => this.word(k)!).join(" ");
      const match = matchTag(typed, tags) ?? matchTag(this.word(tagWords[0]!)!, tags);
      const usedWords = match && match.words < tagWords.length ? tagWords.slice(0, match.words) : tagWords;
      const label = match?.tag ?? usedWords.map((k) => this.t[k]!.raw).join(" ");
      const negation = this.negationBefore(i);
      this.addCriterion({
        kind: "tag",
        negate: Boolean(negation),
        match: "any",
        terms: [],
        tags: [label],
        source: this.raw(negation?.[0] ?? i, usedWords[usedWords.length - 1]! + 1),
        span: [negation?.[0] ?? i, usedWords[usedWords.length - 1]!],
      });
      if (negation) this.takeList(negation, "crit");
      this.take(i, usedWords[usedWords.length - 1]! + 1, "crit");
    }
    // "with the vip tag", "VIP-tagged"
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i) || !["tag", "tagged", "tags"].includes(this.word(i) ?? "")) continue;
      const prev = this.prevMeaningful(i - 1);
      if (prev < 0 || !this.free(prev)) continue;
      const match = matchTag(this.word(prev) ?? "", tags);
      if (!match) continue;
      this.addCriterion({ kind: "tag", negate: false, match: "any", terms: [], tags: [match.tag], source: this.raw(prev, i + 1), span: [prev, i] });
      this.take(prev, i + 1, "crit");
    }
  }

  private markHas(): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const w = this.word(i);
      const negatedVerb = w !== null && NEGATED_HAS_SET.has(w);
      const tEnd = negatedVerb ? i + 1 : this.matchLex(i, L.has);
      if (tEnd === -1) continue;
      const arg = this.argument(tEnd, "has");
      if (!arg.chunks.length) continue;
      const negation = negatedVerb ? [i] : this.negationBefore(i);
      this.createFromArgument(arg, "has", i, tEnd, negation);
      i = arg.end - 1;
    }
  }

  private markBareTerms(): void {
    for (const hit of this.hits) {
      if (!this.free(hit.start)) continue;
      // Gather a list of bare terms joined by or/and/commas ("acne or rosacea patients").
      const chunks: Chunk[] = [{ tokens: range(hit.start, hit.end), hit, text: hit.input, strength: hit.strength }];
      const connectors: ("or" | "and")[] = [];
      const used = range(hit.start, hit.end);
      let j = hit.end;
      while (j < this.n) {
        const w = this.word(j);
        const isComma = this.t[j]?.kind === "punct" && this.t[j]?.norm === ",";
        const conn = isComma ? "or" : w && OR_WORDS.has(w) ? "or" : w && AND_WORDS.has(w) ? "and" : null;
        const next = this.hitAt.get(j + 1);
        if (conn && this.free(j) && next && this.free(next.start) && sameFamily(next.kind, hit.kind)) {
          connectors.push(conn);
          chunks.push({ tokens: range(next.start, next.end), hit: next, text: next.input, strength: next.strength });
          used.push(j, ...range(next.start, next.end));
          j = next.end;
          continue;
        }
        const attached = this.hitAt.get(j);
        if (attached && attached.andPrefix && this.free(attached.start) && sameFamily(attached.kind, hit.kind)) {
          connectors.push("and");
          chunks.push({ tokens: range(attached.start, attached.end), hit: attached, text: attached.input, strength: attached.strength });
          used.push(...range(attached.start, attached.end));
          j = attached.end;
          continue;
        }
        break;
      }
      const kind = hit.kind === "drug" || hit.kind === "class" ? "medication" : hit.kind === "condition" ? "condition" : hit.kind === "procedure" ? "procedure" : "allergy";
      const negation = this.negationBefore(hit.start);
      const terms = this.termsFrom(chunks, kind);
      const from = negation ? negation[0]! : hit.start;
      this.addCriterion({
        kind,
        negate: Boolean(negation),
        match: matchOf(connectors),
        terms,
        source: this.raw(from, j),
        span: [from, j - 1],
      });
      if (negation) this.takeList(negation, "crit");
      this.takeList(used, "crit");
      this.checkMixedConnectors({ chunks, connectors, used });
    }
  }

  private markBareTags(): void {
    const tags = this.ctx.tags ?? [];
    if (!tags.length) return;
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i) || this.t[i]?.kind !== "word") continue;
      for (const len of [3, 2, 1]) {
        const idx = range(i, i + len);
        if (!idx.every((k) => this.free(k) && this.t[k]?.kind === "word")) continue;
        const typed = idx.map((k) => this.word(k)!).join(" ");
        if (len === 1 && (FILLER.has(typed) || KEYWORDS.has(typed) || typed.length < 3)) continue;
        const match = matchTag(typed, tags, { exactOnly: true });
        if (!match || match.words !== len) continue;
        // "new patients": the tag owns the generic word here.
        const negation = this.negationBefore(i);
        this.addCriterion({
          kind: "tag",
          negate: Boolean(negation),
          match: "any",
          terms: [],
          tags: [match.tag],
          source: this.raw(i, i + len),
          span: [negation?.[0] ?? i, i + len - 1],
        });
        if (negation) this.takeList(negation, "crit");
        this.take(i, i + len, "crit");
        i += len - 1;
        break;
      }
    }
  }

  // ── arguments ────────────────────────────────────────────────────────────

  /** Terms after a trigger: "lidocaine or penicillin", "diabetes and hypertension", "tree nuts". */
  private argument(start: number, purpose: "allergy" | "condition" | "medication" | "procedure" | "has"): Argument {
    const chunks: Chunk[] = [];
    const connectors: ("or" | "and")[] = [];
    const used: number[] = [];
    let cur: number[] = [];
    let curHit: TermHit | null = null;
    let curStrength: string | null = null;
    let i = start;
    const flush = () => {
      if (cur.length) {
        chunks.push({ tokens: cur, hit: curHit, text: this.rawOf(cur), strength: curHit?.strength ?? curStrength });
        used.push(...cur);
      }
      cur = [];
      curHit = null;
      curStrength = null;
    };
    // leading articles
    while (i < this.n && this.free(i) && ARG_SKIP.has(this.word(i) ?? "") && !this.hitAt.has(i)) {
      used.push(i);
      i++;
    }
    while (i < this.n && chunks.length < 6) {
      if (!this.free(i)) break;
      const tok = this.t[i]!;
      if (tok.kind === "punct") {
        if (tok.norm === "," && cur.length && this.continuesList(i + 1)) {
          flush();
          connectors.push("or");
          used.push(i);
          i++;
          continue;
        }
        break;
      }
      const hit = this.hitAt.get(i);
      if (hit && this.free(hit.start)) {
        if (hit.andPrefix && (cur.length || chunks.length)) {
          flush();
          connectors.push("and");
        } else if (cur.length && curHit) {
          flush();
          connectors.push("and");
        }
        for (let k = hit.start; k < hit.end; k++) cur.push(k);
        curHit = hit;
        i = hit.end;
        continue;
      }
      const w = this.word(i);
      if (w === null) break;
      if (OR_WORDS.has(w)) {
        if (!cur.length || !this.continuesList(i + 1)) break;
        flush();
        connectors.push("or");
        used.push(i);
        i++;
        continue;
      }
      if (AND_WORDS.has(w)) {
        if (!cur.length || !this.continuesList(i + 1)) break;
        flush();
        connectors.push("and");
        used.push(i);
        i++;
        continue;
      }
      if (tok.kind === "number") {
        // strength after a free-text drug ("zoryve 0.3%")
        if (purpose === "medication" && cur.length && !curHit) {
          const unit = this.word(i + 1);
          if (tok.norm.endsWith("%")) {
            curStrength = tok.norm;
            used.push(i);
            i++;
            continue;
          }
          if (unit && STRENGTH_UNITS.has(unit)) {
            curStrength = `${tok.norm} ${unit}`;
            used.push(i, i + 1);
            i += 2;
            continue;
          }
        }
        break;
      }
      if (STOP.has(w) || (KEYWORDS.has(w) && !FILLER.has(w) && !PROCEDURE_WORD.has(w))) break;
      if (SEX.has(w) || this.isAllergyWord(i)) break;
      if (FILLER.has(w)) {
        if (!cur.length) {
          used.push(i);
          i++;
          continue;
        }
        break;
      }
      if (cur.length >= 5 || (curHit && purpose !== "has" && purpose !== "procedure")) {
        // free words right after a known term end the argument ("penicillin rash")
        if (curHit) break;
      }
      cur.push(i);
      i++;
    }
    flush();
    // A trailing connector without a term is not part of the argument.
    while (connectors.length >= chunks.length && connectors.length) {
      connectors.pop();
      used.pop();
    }
    const end = used.length ? Math.max(...used) + 1 : start;
    return { chunks, connectors, used, end };
  }

  private continuesList(i: number): boolean {
    let j = i;
    while (j < this.n && this.free(j) && ["a", "an", "the", "any"].includes(this.word(j) ?? "")) j++;
    if (!this.free(j)) return false;
    if (this.hitAt.has(j)) return true;
    const w = this.word(j);
    if (w === null || this.t[j]?.kind !== "word") return false;
    return !STOP.has(w) && !KEYWORDS.has(w) && !SEX.has(w) && !this.isAllergyWord(j);
  }

  /** Terms before an allergy word: "a documented lidocaine or penicillin allergy". */
  private argumentBackward(from: number): Argument {
    const items: { tokens: number[]; hit: TermHit | null }[] = [];
    const connectors: ("or" | "and")[] = [];
    const used: number[] = [];
    let i = from;
    while (i >= 0 && this.free(i)) {
      const hit = this.inHit[i];
      if (hit && this.free(hit.start)) {
        items.unshift({ tokens: range(hit.start, hit.end), hit });
        used.push(...range(hit.start, hit.end));
        i = hit.start - 1;
      } else {
        const w = this.word(i);
        if (w === null || this.t[i]?.kind !== "word" || STOP.has(w) || KEYWORDS.has(w) || FILLER.has(w) || SEX.has(w)) break;
        if (this.t[i]?.possessive || (i > 0 && /^[A-Z]/.test(this.t[i]!.raw))) break;
        // one free word ("tree" in "tree nut allergy" is caught by the vocabulary; free words: max 2)
        const free: number[] = [];
        while (i >= 0 && this.free(i) && free.length < 2 && !this.inHit[i]) {
          const fw = this.word(i);
          if (fw === null || this.t[i]?.kind !== "word" || STOP.has(fw) || KEYWORDS.has(fw) || FILLER.has(fw) || SEX.has(fw)) break;
          // "Tarek Ezzat's allergies" names a person, not an allergen.
          if (this.t[i]?.possessive || (i > 0 && /^[A-Z]/.test(this.t[i]!.raw))) break;
          free.unshift(i);
          i--;
        }
        if (!free.length) break;
        items.unshift({ tokens: free, hit: null });
        used.push(...free);
      }
      // connector before this item?
      const w = this.word(i);
      const isComma = this.t[i]?.kind === "punct" && this.t[i]?.norm === ",";
      if (i >= 0 && this.free(i) && (isComma || (w && (OR_WORDS.has(w) || AND_WORDS.has(w))))) {
        const prev = i - 1;
        if (prev >= 0 && this.free(prev) && (this.inHit[prev] || (this.word(prev) && !STOP.has(this.word(prev)!) && !FILLER.has(this.word(prev)!)))) {
          connectors.unshift(isComma || (w && OR_WORDS.has(w)) ? "or" : "and");
          used.push(i);
          i = prev;
          continue;
        }
      }
      break;
    }
    const chunks = items.map((it) => ({ tokens: it.tokens, hit: it.hit, text: this.rawOf(it.tokens), strength: it.hit?.strength ?? null }));
    return { chunks, connectors, used, end: from + 1 };
  }

  /** Turn an argument into criteria; a has-argument may hold several kinds ("with PCOS and on metformin"). */
  private createFromArgument(
    arg: Argument,
    purpose: "condition" | "medication" | "procedure" | "has",
    triggerStart: number,
    triggerEnd: number,
    negation: number[] | null,
  ): void {
    const groups = new Map<"allergy" | "condition" | "medication" | "procedure", { chunks: Chunk[]; idx: number[] }>();
    arg.chunks.forEach((c, idx) => {
      const kind = purpose === "has" ? this.kindForHas(c) : purpose === "condition" && c.hit?.kind === "procedure" ? "procedure" : purpose;
      if (!groups.has(kind)) groups.set(kind, { chunks: [], idx: [] });
      groups.get(kind)!.chunks.push(c);
      groups.get(kind)!.idx.push(idx);
    });
    if (groups.size > 1 && arg.connectors.includes("or")) {
      this.problems.push({ text: this.raw(triggerStart, arg.end), reason: "“or” between different kinds of criteria is not supported; ask them separately" });
      this.take(triggerStart, arg.end, "problem");
      return;
    }
    const from = negation ? negation[0]! : triggerStart;
    for (const [kind, g] of groups) {
      const connectors = g.idx.slice(1).map((k) => arg.connectors[k - 1] ?? "and");
      const anyProcedure = kind === "procedure" && g.chunks.every((c) => !c.hit && c.tokens.every((k) => PROCEDURE_WORD.has(this.word(k) ?? "")));
      this.addCriterion({
        kind,
        negate: Boolean(negation),
        match: matchOf(connectors),
        terms: anyProcedure ? [anyTerm()] : this.termsFrom(g.chunks, kind),
        source: this.raw(from, arg.end),
        span: [from, arg.end - 1],
      });
    }
    if (negation) this.takeList(negation, "crit");
    this.take(triggerStart, triggerEnd, "crit");
    this.takeList(arg.used, "crit");
    this.checkMixedConnectors(arg);
  }

  private kindForHas(c: Chunk): "allergy" | "condition" | "medication" | "procedure" {
    if (c.hit) {
      if (c.hit.kind === "drug" || c.hit.kind === "class") return "medication";
      if (c.hit.kind === "procedure") return "procedure";
      return "condition";
    }
    if (c.tokens.some((k) => PROCEDURE_WORD.has(this.word(k) ?? ""))) return "procedure";
    return "condition";
  }

  private checkMixedConnectors(arg: { connectors: ("or" | "and")[]; chunks: Chunk[]; used: number[] }): void {
    if (arg.connectors.includes("or") && arg.connectors.includes("and")) {
      this.problems.push({
        text: this.rawOf(arg.used),
        reason: "mixes “and” and “or”; say “any of” or “all of”",
      });
    }
  }

  /** TermSpecs for the chunks of an argument, by criterion kind. */
  private termsFrom(chunks: Chunk[], kind: "allergy" | "condition" | "medication" | "procedure"): TermSpec[] {
    return chunks.map((c) => this.termFor(c, kind));
  }

  private termFor(c: Chunk, kind: "allergy" | "condition" | "medication" | "procedure"): TermSpec {
    const input = c.hit ? c.hit.input : tidy(c.text);
    if (c.hit?.conceptId || c.hit?.classId) return conceptTerm(c.hit.conceptId, c.hit.classId, kind, input, c.hit.fuzzy, c.strength);
    if (c.hit) {
      // a tenant medication name not in the static vocabulary
      return { ...freeTerm(input, [c.hit.label.split(" ")]), strength: c.strength };
    }
    // free text: correct a typo against the vocabulary of this kind, then the clinic's own record terms
    let ws = c.tokens.map((k) => this.word(k) ?? "").filter((w) => w && !ARG_SKIP.has(w));
    if (kind === "procedure") {
      const stripped = ws.filter((w) => !PROCEDURE_WORD.has(w));
      if (stripped.length) ws = stripped;
    }
    const wanted: ConceptKind[] = kind === "medication" ? ["drug"] : kind === "condition" ? ["condition"] : kind === "procedure" ? ["procedure"] : ["drug", "allergen"];
    const fuzzy = fuzzyConcept(ws, wanted);
    if (fuzzy) return conceptTerm(fuzzy, null, kind, input, true, c.strength);
    const corrected = correctFromRecords(ws, this.ctx.recordTerms ?? []);
    if (corrected) return { ...freeTerm(input, [corrected]), label: corrected.join(" "), corrected: true, strength: c.strength };
    return { ...freeTerm(input, [ws]), strength: c.strength };
  }

  // ── intent, connectors, leftovers ────────────────────────────────────────

  private markIntent(): Intent {
    let i = 0;
    while (i < this.n && (this.t[i]?.kind === "punct" || (this.free(i) && LEADING_SKIP.has(this.word(i) ?? "")) || this.claim[i] === "filler")) i++;
    const countEnd = this.matchLex(i, L.count, { allowClaimed: false });
    if (countEnd !== -1) {
      this.take(i, countEnd, "intent");
      return "count";
    }
    const listEnd = this.matchLex(i, L.list);
    if (listEnd !== -1) {
      this.take(i, listEnd, "intent");
      // "how many" later in the sentence turns it into a count
      for (let k = listEnd; k < this.n; k++) {
        const e = this.matchLex(k, L.count);
        if (e !== -1) {
          this.take(k, e, "intent");
          return "count";
        }
      }
      return "list";
    }
    const openEnd = this.matchLex(i, L.open);
    if (openEnd !== -1) return "open";
    const first = this.word(i);
    if (first && CHECK_OPENERS.has(first)) {
      // "Is there / are there / do we have …" are list questions (caught above); the rest are yes/no checks.
      this.take(i, i + 1, "intent");
      return "check";
    }
    // "patients with PCOS", "penicillin allergy?" (a search phrase), or a statement
    for (let k = 0; k < this.n; k++) {
      const e = this.matchLex(k, L.count);
      if (e !== -1) {
        this.take(k, e, "intent");
        return "count";
      }
    }
    if (this.criteria.length) {
      const leftover = this.leftover();
      if (!leftover.length || first === "patients" || first === "المرضى" || first === "مرضى") return "list";
    }
    return "open";
  }

  /** Adjacent same-kind criteria joined by "or" merge; different kinds joined by "or" are a problem. */
  private mergeAndCheckConnectors(): void {
    for (let i = 0; i < this.n; i++) {
      const w = this.word(i);
      if (!this.free(i) || w === null || !OR_WORDS.has(w)) continue;
      const before = this.criteria.filter((c) => c.span[1] < i).sort((a, b) => b.span[1] - a.span[1])[0];
      const after = this.criteria.filter((c) => c.span[0] > i).sort((a, b) => a.span[0] - b.span[0])[0];
      if (!before || !after) continue;
      const gapClear = (from: number, to: number) => range(from, to).every((k) => !this.free(k) || FILLER.has(this.word(k) ?? "") || k === i);
      if (!gapClear(before.span[1] + 1, after.span[0])) continue;
      if (before.kind === after.kind && before.negate === after.negate && before.terms.length && after.terms.length) {
        before.terms.push(...after.terms);
        before.match = "any";
        before.source = `${before.source} or ${after.source}`;
        before.span = [before.span[0], after.span[1]];
        this.criteria.splice(this.criteria.indexOf(after), 1);
        this.claim[i] = "conn";
      } else {
        this.problems.push({ text: this.raw(before.span[0], after.span[1] + 1), reason: "“or” between different kinds of criteria is not supported; ask them separately" });
        this.claim[i] = "problem";
      }
    }
  }

  /**
   * A time limit nobody used ("treated for acne TODAY", "seen by Dr. Omar
   * SINCE MARCH"): report it, because answering without it would answer a
   * broader question than the one asked.
   */
  private checkDanglingTime(): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const w = this.word(i);
      if (w === null) continue;
      const start = TIME_START.has(w) || (MONTH.has(w) && i > 0 && ["in", "since", "from", "before", "after", "during", "في", "من", "منذ"].includes(this.word(i - 1) ?? ""));
      const unit = (w === "week" || w === "month" || w === "year" || w === "الاسبوع" || w === "الشهر" || w === "السنه") && ["this", "last", "next", "past", "ده", "دي", "الجاي", "اللي"].some((x) => x === this.word(i - 1) || x === this.word(i + 1));
      if (!start && !unit) continue;
      let from = i;
      if (unit && ["this", "last", "next", "past"].includes(this.word(i - 1) ?? "") && this.free(i - 1)) from = i - 1;
      let end = i + 1;
      while (end < this.n && end - i < 3 && this.free(end) && this.t[end]?.kind !== "punct" && (this.numberAt(end) !== null || MONTH.has(this.word(end) ?? "") || UNIT.has(this.word(end) ?? "") || ["the", "last", "past", "ago"].includes(this.word(end) ?? ""))) end++;
      this.problems.push({ text: this.raw(from, end), reason: "a time limit is only understood for appointments and visits" });
      this.take(from, end, "problem");
      i = end - 1;
    }
  }

  private checkDanglingNegations(): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.free(i)) continue;
      const end = this.matchLex(i, L.negation);
      if (end === -1) continue;
      const w = this.word(i);
      // "non" before a hyphenated word or "no" as the first word of a reply are not filters
      if ((w === "no" || w === "لا") && i === 0) continue;
      this.problems.push({ text: this.raw(i, Math.min(this.n, end + 2)), reason: "this negation could not be attached to a criterion" });
      this.take(i, end, "problem");
    }
  }

  private leftover(): Phrase[] {
    const phrases: Phrase[] = [];
    let cur: number[] = [];
    let gap: number[] = [];
    const flush = () => {
      if (cur.length) {
        const all = [...cur].sort((a, b) => a - b);
        phrases.push({
          text: this.raw(all[0]!, all[all.length - 1]! + 1),
          tokens: all,
          words: all.map((k) => this.word(k) ?? ""),
          possessive: all.some((k) => this.t[k]?.possessive),
        });
      }
      cur = [];
      gap = [];
    };
    for (let i = 0; i < this.n; i++) {
      const tok = this.t[i]!;
      if (this.claim[i] !== null || tok.kind === "punct" || tok.kind === "symbol") {
        flush();
        continue;
      }
      const w = tok.norm;
      if (FILLER.has(w) || isFillerTypo(w) || (tok.kind === "word" && KEYWORDS.has(w) && !this.isNameLike(i))) {
        if (cur.length) gap.push(i);
        continue;
      }
      if (gap.length) {
        // fillers inside a phrase ("due THEIR month 3 photo set") belong to it
        cur.push(...gap);
        gap = [];
      }
      cur.push(i);
    }
    flush();
    return phrases;
  }

  /** Summarise / compare / explain / describe …: prose over records, not a look-up. */
  private isNarrative(): boolean {
    let i = 0;
    while (i < this.n && (this.t[i]?.kind === "punct" || LEADING_SKIP.has(this.word(i) ?? "") || ["can", "could", "would", "you", "please", "ممكن"].includes(this.word(i) ?? ""))) i++;
    return this.matchLex(i, NARRATIVE, { allowClaimed: true }) !== -1;
  }

  private isNameLike(i: number): boolean {
    // A keyword can still be part of a name when it is written with a capital ("Hope", "Amal").
    const raw = this.t[i]?.raw ?? "";
    return /^[A-Z][a-z]/.test(raw) && i > 0 && !["Which", "Who", "List", "Show", "Is", "Are", "Does", "Do", "How", "What"].includes(raw);
  }

  private subject(intent: Intent, leftover: Phrase[]): Phrase | null {
    const named = leftover.find((p) => p.possessive);
    if (named) return named;
    if (intent === "check") {
      const early = leftover.find((p) => p.tokens[0]! <= 3);
      if (early) return early;
    }
    // "allergies for Tarek Ezzat", "about Sara Ibrahim"
    for (const p of leftover) {
      const before = this.word(p.tokens[0]! - 1);
      if (before && ["for", "about", "of", "regarding", "لـ", "عن", "بتاع", "بتاعت", "لل"].includes(before)) return p;
    }
    return null;
  }

  private addCriterion(c: Criterion): void {
    this.criteria.push(c);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

const LONG_FILLERS = [...FILLER].filter((f) => f.length >= 7 && !isArabic(f));

/** "pateints", "curently", "documnted": a typo of a long filler word. */
function isFillerTypo(w: string): boolean {
  if (w.length < 6 || isArabic(w)) return false;
  return LONG_FILLERS.some((f) => f[0] === w[0] && editDistance(w, f, f.length >= 9 ? 2 : 1) <= (f.length >= 9 ? 2 : 1));
}

/** The words of a recognised term as typed, without an attached Arabic "and"/preposition ("للبنسلين" → "البنسلين"). */
function displayInput(raw: string, andPrefix: boolean): string {
  let out = raw;
  if (andPrefix) out = out.replace(/^و/, "");
  return out.replace(/^(?:لل)/, "ال").replace(/^(?:بال|فال|كال|وال)/, "ال");
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

function matchOf(connectors: ("or" | "and")[]): "any" | "all" {
  return connectors.includes("and") && !connectors.includes("or") ? "all" : "any";
}

function sameFamily(a: TermHit["kind"], b: TermHit["kind"]): boolean {
  const fam = (k: TermHit["kind"]) => (k === "class" ? "drug" : k);
  return fam(a) === fam(b);
}

/** Lexicon equality: exact, article/plural variants, or a small typo in a long keyword. */
function keywordEq(tok: string, lexWord: string): boolean {
  if (tok === lexWord) return true;
  if (sameWordExact(tok, lexWord)) return true;
  if (lexWord.length >= 7 && tok.length >= 6 && tok[0] === lexWord[0] && !/\d/.test(tok) && !isArabic(tok)) {
    const budget = lexWord.length >= 9 ? 2 : 1;
    return editDistance(tok, lexWord, budget) <= budget;
  }
  return false;
}

/** A question word may be a typo of a vocabulary word only when it is long enough and not a known keyword. */
function canBeTypo(tok: string): boolean {
  if (KEYWORDS.has(tok) || /\d/.test(tok)) return false;
  return isArabic(tok) ? tok.length >= 5 : tok.length >= 5;
}

function nameEq(q: string, name: string): boolean {
  if (sameWord(q, name)) return true;
  const translit = TRANSLIT.get(q) ?? (q.startsWith("ال") ? TRANSLIT.get(q.slice(2)) : undefined);
  return Boolean(translit?.some((t) => t === name || sameWordExact(t, name)));
}

const TITLE_WORDS = new Set(["dr", "doctor", "prof", "professor", "د", "دكتور", "دكتوره", "الدكتور", "الدكتوره", "mr", "mrs", "ms", "miss"]);

function doctorNameWords(name: string): string[] {
  return words(name).filter((w) => !TITLE_WORDS.has(w));
}

function anyTerm(): TermSpec {
  return { input: "any", label: "any", conceptId: null, classId: null, classLabel: null, phrases: [], phraseOwners: [], corrected: false, strength: null, any: true };
}

function freeTerm(input: string, phrases: string[][]): TermSpec {
  const clean = phrases.filter((p) => p.length);
  return {
    input,
    label: clean[0]?.join(" ") || input,
    conceptId: null,
    classId: null,
    classLabel: null,
    phrases: clean,
    phraseOwners: clean.map(() => null),
    corrected: false,
    strength: null,
    any: false,
  };
}

/**
 * The phrases searched for a concept or class. An allergy to a member of a
 * cross-reactive class is searched as the whole class.
 */
export function conceptTerm(
  conceptId: string | null,
  classId: string | null,
  kind: "allergy" | "condition" | "medication" | "procedure",
  input: string,
  corrected: boolean,
  strength: string | null,
): TermSpec {
  const phrases: string[][] = [];
  const owners: (string | null)[] = [];
  const add = (names: string[], owner: string | null) => {
    for (const n of names) {
      const w = words(n);
      if (w.length) {
        phrases.push(w);
        owners.push(owner);
      }
    }
  };
  let label = input;
  let classLabel: string | null = null;
  if (conceptId) {
    const c = conceptById(conceptId)!;
    label = c.label;
    add(c.names, c.id);
    if (kind === "allergy") {
      const cls = (c.classes ?? []).map((id) => drugClassById(id)).find((k) => k?.crossReactive);
      if (cls) {
        classLabel = cls.label;
        add(cls.names, cls.id);
        for (const m of classMembers(cls.id)) if (m.id !== c.id) add(m.names, m.id);
      }
    }
  } else if (classId) {
    const cls = drugClassById(classId)!;
    label = cls.label;
    classLabel = cls.label;
    add(cls.names, cls.id);
    for (const m of classMembers(cls.id)) add(m.names, m.id);
  }
  return { input, label, conceptId, classId, classLabel, phrases, phraseOwners: owners, corrected, strength, any: false };
}

/** The one concept of the wanted kinds whose name is within typo distance of the words, or null. */
function fuzzyConcept(ws: string[], kinds: ConceptKind[]): string | null {
  if (!ws.length || ws.length > 4) return null;
  const hits = new Set<string>();
  for (const c of CONCEPTS) {
    if (!kinds.includes(c.kind)) continue;
    for (const name of c.names) {
      const nw = words(name);
      if (nw.length !== ws.length) continue;
      if (nw.every((w, k) => sameWord(ws[k]!, w))) hits.add(c.id);
    }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}

/** Correct a misspelt free-text term against the clinic's own record terms ("psoraisis" → "psoriasis"). */
function correctFromRecords(ws: string[], recordTerms: string[]): string[] | null {
  if (ws.length !== 1) return null;
  const q = ws[0]!;
  if (q.length < 5) return null;
  const candidates = new Set<string>();
  for (const term of recordTerms) {
    for (const w of words(term)) {
      if (w === q) return null; // spelled as recorded: nothing to correct
      if (w.length >= 5 && w[0] === q[0] && sameWord(q, w)) candidates.add(w);
    }
  }
  return candidates.size === 1 ? [[...candidates][0]!] : null;
}

/** Match typed words to one of the clinic's tags ("new patients" → "new-patient", "VIP" → "vip"). */
export function matchTag(typed: string, tags: string[], opts: { exactOnly?: boolean } = {}): { tag: string; words: number } | null {
  const tw = words(typed.replace(/[-_]/g, " "));
  if (!tw.length) return null;
  let best: { tag: string; words: number } | null = null;
  for (const tag of tags) {
    const gw = words(tag.replace(/[-_]/g, " "));
    if (!gw.length || gw.length > tw.length) continue;
    const exact = gw.every((w, k) => sameWordExact(tw[k]!, w));
    const fuzzy = !opts.exactOnly && gw.every((w, k) => sameWord(tw[k]!, w));
    if ((exact || fuzzy) && (!best || gw.length > best.words)) best = { tag, words: gw.length };
  }
  return best;
}

/**
 * A term as shown to the reader: the canonical label, with the words typed in
 * front when they say something else ("Keflex (cephalexin)", "البنسلين
 * (penicillin)"), and the strength asked for.
 */
export function termDisplay(t: TermSpec): string {
  if (t.any) return "any";
  const typed = normalizeText(t.input ?? "").trim();
  const label = normalizeText(t.label).trim();
  const showTyped = typed && !t.corrected && !typed.includes(label) && !label.includes(typed);
  const base = showTyped ? `${t.input} (${t.label})` : t.label;
  return t.strength ? `${base} ${t.strength}` : base;
}

/** The criteria a question asks for, in plain English (for answers, chips and the audit trail). */
export function describeCriterion(c: Criterion): string {
  const terms = (sep: "or" | "and") => c.terms.map(termDisplay).join(` ${sep} `);
  const list = terms(c.match === "all" ? "and" : "or");
  const not = c.negate ? "no " : "";
  switch (c.kind) {
    case "allergy":
      if (c.terms.some((t) => t.any)) return c.negate ? "no recorded allergies" : "any recorded allergy";
      return `${c.negate ? "no recorded allergy to" : "allergy to"} ${list}`;
    case "condition":
      return `${not}condition or diagnosis: ${list}`;
    case "medication":
      return `${c.negate ? "not on" : "active medication:"} ${list}`;
    case "procedure":
      if (c.terms.some((t) => t.any)) return c.negate ? "no recorded surgery" : "any recorded surgery";
      return `${not}surgery or procedure: ${list}`;
    case "sex":
      return (c.sexes ?? []).map((s) => (s === "MALE" ? "male" : "female")).join(" or ");
    case "age":
      return `age ${c.age?.text ?? ""}`;
    case "tag":
      return `${c.negate ? "not tagged" : "tagged"} ${(c.tags ?? []).join(" or ")}`;
    case "doctor":
      return `${c.negate ? "never seen by" : "patient of"} ${(c.doctors ?? []).map((d) => d.name).join(" or ")}`;
    case "appointment":
      return `${c.negate ? "no appointment" : "appointment"} ${c.window?.label ?? "upcoming"}`;
    case "lastVisit":
      return c.cutoff?.label ?? "no visit";
  }
}

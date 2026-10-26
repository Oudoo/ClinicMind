import type { ProtocolQuestion } from "./protocols";

/**
 * Triage: a patient's answers against the step's questions → flags and a
 * level. Pure and synchronous so it is unit-tested without the database and
 * shared by the public check-in, the staff "answer by phone" path and the seed.
 *
 *  - HIGH_RISK when a high-risk question is outside its expected range, a
 *    numeric answer falls in a question's `danger` range, or the free text says
 *    the patient cannot breathe;
 *  - WATCH when any other question is outside its expected range or the free
 *    text mentions a red-flag word (bleeding, fever, pus, severe…);
 *  - OK otherwise.
 */
export type TriageLevel = "OK" | "WATCH" | "HIGH_RISK";

export interface TriageFlag {
  key: string;
  /** English label for the board; "Free text" for red-flag words. */
  label: string;
  value: unknown;
  /** Human description of the expected range ("no", "≤ 4"), null for free text. */
  expected: string | null;
  highRisk: boolean;
}

export interface TriageResult {
  level: TriageLevel;
  flags: TriageFlag[];
}

export type AnswerMap = Record<string, unknown>;

const LEVEL_RANK: Record<TriageLevel, number> = { OK: 0, WATCH: 1, HIGH_RISK: 2 };

export function maxLevel(a: TriageLevel, b: TriageLevel): TriageLevel {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// ── Red-flag words in free text ──────────────────────────────────────────────

interface RedFlag {
  label: string;
  en: RegExp;
  ar: RegExp;
  highRisk?: boolean;
}

/** Arabic text normalised for matching: hamza forms, taa marbuta, diacritics. */
export function normalizeArabic(s: string): string {
  return s
    .replace(/[ً-ْـ]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .toLowerCase();
}

const RED_FLAGS: readonly RedFlag[] = [
  {
    label: "cannot breathe",
    en: /\b(can\s?['’]?\s?t|cannot|can not|unable to|hard to|difficult(?:y)? (?:to )?)\s*breath(?:e|ing)\b|\bshort(?:ness)? of breath\b|\bbreathless/i,
    ar: /مش قادر[هة]? اتنفس|مش عارف[هة]? اتنفس|م?ا? ?ب?قدرش اتنفس|صعوب[هة]? (?:في )?(?:ال)?تنفس|ضيق (?:في )?(?:ال)?(?:تنفس|نفس)|مش قادر[هة]? اخد نفس/,
    highRisk: true,
  },
  { label: "bleeding", en: /\bbleed(?:s|ing)?\b|\bblood\b/i, ar: /نزيف|نزف|بينزف|بتنزف|دم بيطلع|دم كتير/ },
  { label: "fever", en: /\bfever(?:ish)?\b|\btemperature\b/i, ar: /حراره|سخوني[هة]|سخون[هة]|حمى|سخن[هة]?\b/ },
  { label: "pus", en: /\bpus\b|\bdischarge\b/i, ar: /صديد|قيح|افرازات صفرا/ },
  { label: "severe", en: /\bsevere(?:ly)?\b|\bunbearable\b/i, ar: /شديد|جامد اوي|مش مستحمل/ },
];

/** Red-flag words found in a piece of free text. */
export function scanFreeText(textValue: string | null | undefined): TriageFlag[] {
  const raw = (textValue ?? "").trim();
  if (!raw) return [];
  const normalized = normalizeArabic(raw);
  const flags: TriageFlag[] = [];
  for (const flag of RED_FLAGS) {
    const match = flag.en.exec(raw) ?? flag.ar.exec(normalized);
    if (!match) continue;
    flags.push({ key: "freeText", label: `Free text mentions ${flag.label}`, value: match[0], expected: null, highRisk: Boolean(flag.highRisk) });
  }
  return flags;
}

// ── Structured answers ───────────────────────────────────────────────────────

/** "no", "≤ 4", "≥ 6", "3–5", or null when the question has no expectation. */
export function describeExpected(q: ProtocolQuestion): string | null {
  const e = q.expected;
  if (!e) return null;
  if (q.type === "yesno") return typeof e.value === "boolean" ? (e.value ? "yes" : "no") : null;
  if (e.min !== undefined && e.max !== undefined) return `${e.min}–${e.max}`;
  if (e.max !== undefined) return `≤ ${e.max}`;
  if (e.min !== undefined) return `≥ ${e.min}`;
  return null;
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function boolish(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === "yes" || value === "true" || value === 1 || value === "1") return true;
  if (value === "no" || value === "false" || value === 0 || value === "0") return false;
  return null;
}

/** Evaluate one answer. Returns null when the answer is missing or not flaggable. */
export function evaluateAnswer(q: ProtocolQuestion, value: unknown): { flag: TriageFlag; level: TriageLevel }[] {
  if (value === undefined || value === null || value === "") return [];
  if (q.type === "text") {
    return scanFreeText(String(value)).map((f) => ({
      flag: { ...f, key: q.key, label: `${q.label.en}: ${f.label.replace(/^Free text mentions /, "mentions ")}` },
      level: f.highRisk ? "HIGH_RISK" : "WATCH",
    }));
  }
  if (q.type === "yesno") {
    const v = boolish(value);
    const expected = q.expected?.value;
    if (v === null || typeof expected !== "boolean" || v === expected) return [];
    const level: TriageLevel = q.highRisk ? "HIGH_RISK" : "WATCH";
    return [{ flag: { key: q.key, label: q.label.en, value: v, expected: expected ? "yes" : "no", highRisk: level === "HIGH_RISK" }, level }];
  }
  const v = numeric(value);
  if (v === null) return [];
  const inDanger = Boolean(q.danger && ((q.danger.min !== undefined && v >= q.danger.min) || (q.danger.max !== undefined && v <= q.danger.max)));
  const outside = Boolean(q.expected && ((q.expected.min !== undefined && v < q.expected.min) || (q.expected.max !== undefined && v > q.expected.max)));
  if (!inDanger && !outside) return [];
  const level: TriageLevel = inDanger || q.highRisk ? "HIGH_RISK" : "WATCH";
  return [{ flag: { key: q.key, label: q.label.en, value: v, expected: describeExpected(q), highRisk: level === "HIGH_RISK" }, level }];
}

/**
 * The step's questions against the answers (plus the optional free text).
 * Unknown answer keys are ignored; missing answers are not flagged.
 */
export function triageAnswers(
  step: { questions?: ProtocolQuestion[] | undefined },
  answers: AnswerMap,
  freeText?: string | null,
): TriageResult {
  let level: TriageLevel = "OK";
  const flags: TriageFlag[] = [];
  for (const q of step.questions ?? []) {
    for (const hit of evaluateAnswer(q, answers[q.key])) {
      flags.push(hit.flag);
      level = maxLevel(level, hit.level);
    }
  }
  for (const f of scanFreeText(freeText)) {
    flags.push(f);
    level = maxLevel(level, f.highRisk ? "HIGH_RISK" : "WATCH");
  }
  return { level, flags };
}

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Phrase } from "./parser";
import { isArabic, normalizeText, sameName, words } from "./text";
import { NAME_TRANSLITERATIONS } from "./vocabulary";

/**
 * Resolving the patient a question names ("Is Tarek Ezzat on cephalexin?").
 *
 * Exact full-name matches win; then a full name with small typos ("Tarik
 * Ezat"); a first or last name alone ("Is Ahmed on finasteride?") is accepted
 * only for the person the question is about and only when exactly one patient
 * carries it, otherwise the caller asks which one. Arabic spellings of common
 * Latin-script names are recognised ("طارق عزت" → Tarek Ezzat). Always
 * tenant-scoped; archived patients are never matched.
 */

export interface PatientRef {
  id: string;
  fullName: string;
}

export type PatientResolution =
  | { status: "none" }
  | { status: "resolved"; patient: PatientRef; phrase: Phrase; how: "exact" | "fuzzy" | "partial" }
  | { status: "ambiguous"; candidates: PatientRef[]; phrase: Phrase }
  | { status: "not_found"; phrase: Phrase };

const TRANSLIT = new Map(Object.entries(NAME_TRANSLITERATIONS).map(([k, v]) => [normalizeText(k), v] as const));
const MAX_CANDIDATES = 300;

/** Latin spellings to try for a question word (itself, or the transliterations of an Arabic name). */
function spellings(word: string): string[] {
  if (!isArabic(word)) return [word];
  const base = word.startsWith("ال") && !TRANSLIT.has(word) ? word.slice(2) : word;
  const latin = TRANSLIT.get(word) ?? TRANSLIT.get(base) ?? [];
  return [word, ...latin.flatMap((l) => words(l))];
}

interface Scored {
  patient: PatientRef;
  /** Every word of the patient's name is in the phrase. */
  full: boolean;
  /** All matched words were exact (no typo tolerance). */
  exact: boolean;
  /** Every word of the phrase is part of the patient's name. */
  phraseCovered: boolean;
  matched: number;
}

function score(patient: PatientRef, phraseWords: string[]): Scored | null {
  const nameWords = words(patient.fullName);
  if (!nameWords.length) return null;
  let exact = true;
  const usedPhrase = new Set<number>();
  let matchedName = 0;
  for (const nw of nameWords) {
    let found = -1;
    let foundExact = false;
    phraseWords.forEach((pw, k) => {
      if (usedPhrase.has(k) || found !== -1) return;
      for (const s of spellings(pw)) {
        if (s === nw) {
          found = k;
          foundExact = true;
          return;
        }
      }
      for (const s of spellings(pw)) {
        if (sameName(s, nw)) {
          found = k;
          foundExact = s === nw || normalizeText(s) === nw;
          return;
        }
      }
    });
    if (found !== -1) {
      usedPhrase.add(found);
      matchedName++;
      if (!foundExact) exact = false;
    }
  }
  if (!matchedName) return null;
  return {
    patient,
    full: matchedName === nameWords.length,
    exact,
    phraseCovered: usedPhrase.size === phraseWords.length,
    matched: matchedName,
  };
}

/** Tenant patients whose name shares a word (or a near spelling) with the phrase. */
async function candidatesFor(tenantId: string, phraseWords: string[], restrictTo?: string[]): Promise<PatientRef[]> {
  const latin = [...new Set(phraseWords.flatMap(spellings).filter((w) => !isArabic(w) && w.length >= 2))];
  const arabic = phraseWords.filter((w) => isArabic(w) && w.length >= 2);
  const patterns = [...latin, ...arabic].map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (!patterns.length) return [];
  const restrict = restrictTo?.length ? Prisma.sql`AND id = ANY(${restrictTo})` : Prisma.empty;
  // Trigram word similarity catches a misspelt name ("Tarik Ezat"); ILIKE catches the rest.
  const fuzzy = latin.filter((w) => w.length >= 4);
  const similarity = fuzzy.length
    ? Prisma.sql`OR ${Prisma.join(
        fuzzy.map((w) => Prisma.sql`word_similarity(${w}, "fullName") >= 0.45`),
        " OR ",
      )}`
    : Prisma.empty;
  return db.$queryRaw<PatientRef[]>(Prisma.sql`
    SELECT id, "fullName" FROM patients
    WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL ${restrict}
      AND ("fullName" ILIKE ANY(${patterns}) ${similarity})
    ORDER BY "fullName" ASC
    LIMIT ${MAX_CANDIDATES}
  `);
}

/**
 * Find the patient named in the question. `phrases` are the question's
 * leftover phrases (not criteria, not filler); `subject` is the phrase the
 * question is about ("Is <X> on …", "<X>'s allergies"), which may be a first
 * name only.
 */
export async function resolvePatientMention(
  tenantId: string,
  phrases: Phrase[],
  subject: Phrase | null,
  opts: { restrictTo?: string[] } = {},
): Promise<PatientResolution> {
  const ordered = subject ? [subject, ...phrases.filter((p) => p !== subject && p.text !== subject.text)] : phrases;
  let firstAmbiguous: PatientResolution | null = null;
  for (const phrase of ordered) {
    const phraseWords = phrase.words.filter((w) => w && !/^\d/.test(w));
    if (!phraseWords.length || phraseWords.length > 6) continue;
    const candidates = await candidatesFor(tenantId, phraseWords, opts.restrictTo);
    const scored = candidates.map((c) => score(c, phraseWords)).filter((s): s is Scored => Boolean(s));
    const fullExact = scored.filter((s) => s.full && s.exact);
    const fullFuzzy = scored.filter((s) => s.full && !s.exact);
    if (fullExact.length === 1) return { status: "resolved", patient: fullExact[0]!.patient, phrase, how: "exact" };
    if (fullExact.length > 1) {
      // The longest exact name wins ("Ahmed Saleh Kamel" over "Ahmed Saleh" when all three words were typed).
      const longest = Math.max(...fullExact.map((s) => s.matched));
      const top = fullExact.filter((s) => s.matched === longest);
      if (top.length === 1) return { status: "resolved", patient: top[0]!.patient, phrase, how: "exact" };
      firstAmbiguous ??= { status: "ambiguous", candidates: top.map((s) => s.patient), phrase };
      continue;
    }
    if (fullFuzzy.length === 1 && fullFuzzy[0]!.matched >= 2) return { status: "resolved", patient: fullFuzzy[0]!.patient, phrase, how: "fuzzy" };
    if (fullFuzzy.length > 1) {
      firstAmbiguous ??= { status: "ambiguous", candidates: fullFuzzy.map((s) => s.patient).slice(0, 10), phrase };
      continue;
    }
    // A first or last name alone: only for the person the question is about.
    if (phrase === subject || phrase.possessive) {
      const partial = scored.filter((s) => s.phraseCovered && s.exact);
      if (partial.length === 1) return { status: "resolved", patient: partial[0]!.patient, phrase, how: "partial" };
      if (partial.length > 1) {
        firstAmbiguous ??= {
          status: "ambiguous",
          candidates: partial.map((s) => s.patient).sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, 10),
          phrase,
        };
        continue;
      }
      const looksLikeName = phrase.tokens.length <= 4 && (isArabic(phrase.text) || /(^|\s)[A-Z][a-z]/.test(phrase.text));
      if (!scored.length && looksLikeName) {
        firstAmbiguous ??= { status: "not_found", phrase };
      } else if (scored.length && looksLikeName) {
        firstAmbiguous ??= {
          status: "ambiguous",
          candidates: scored
            .sort((a, b) => b.matched - a.matched || a.patient.fullName.localeCompare(b.patient.fullName))
            .map((s) => s.patient)
            .slice(0, 10),
          phrase,
        };
      }
    }
  }
  return firstAmbiguous ?? { status: "none" };
}

/**
 * Patients of the tenant whose full name appears in a text (an AI answer).
 * Used to catch an answer that names a patient it does not cite.
 */
export async function patientsNamedIn(tenantId: string, text: string): Promise<PatientRef[]> {
  const tokens = words(text).filter((w) => w.length >= 3 && !/^\d/.test(w));
  if (!tokens.length) return [];
  const unique = [...new Set(tokens)].slice(0, 400);
  const patterns = unique.filter((w) => !isArabic(w)).map((w) => `${w}%`);
  if (!patterns.length) return [];
  const rows = await db.$queryRaw<PatientRef[]>(Prisma.sql`
    SELECT id, "fullName" FROM patients
    WHERE "tenantId" = ${tenantId} AND "deletedAt" IS NULL
      AND lower(split_part("fullName", ' ', 1)) LIKE ANY(${patterns})
    LIMIT 2000
  `);
  const out: PatientRef[] = [];
  for (const p of rows) {
    const nameWords = words(p.fullName);
    if (nameWords.length < 2) continue;
    for (let i = 0; i + nameWords.length <= tokens.length; i++) {
      if (nameWords.every((w, k) => tokens[i + k] === w)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

/**
 * Text handling shared by the assistant's question parser and its record
 * matcher, so a word typed in a question and the same word written in a chart
 * compare equal: case, Arabic spelling variants (hamza forms, ta marbuta, alef
 * maqsura, diacritics, tatweel), Arabic-Indic digits, the Arabic article and
 * attached prepositions, English plurals and possessives, and small typos.
 *
 * Everything here is pure and deterministic (no database, no AI).
 */

const COMBINING_MARKS = /[̀-ͯؐ-ًؚ-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to ASCII. */
export function toAsciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Canonical comparison form: lower case, digits in ASCII, accents and Arabic
 * diacritics removed, أ/إ/آ → ا, ؤ → و, ئ → ي, ة → ه, ى → ي.
 */
export function normalizeText(s: string): string {
  return toAsciiDigits(s)
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .replace(TATWEEL, "")
    .toLowerCase()
    .replace(/[ٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[’‘`´]/g, "'")
    .replace(/[،]/g, ",")
    .replace(/[؟]/g, "?")
    .replace(/[؛]/g, ";");
}

export const ARABIC_LETTER = /[؀-ۿ]/;

export function isArabic(s: string): boolean {
  return ARABIC_LETTER.test(s);
}

/** True when most letters of the question are Arabic (the answer then uses Arabic headlines). */
export function isMostlyArabic(s: string): boolean {
  const arabic = (s.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (s.match(/[A-Za-z]/g) ?? []).length;
  return arabic > 0 && arabic >= latin;
}

export type TokenKind = "word" | "number" | "punct" | "symbol";

export interface Token {
  /** The text as typed (for showing which part of a question was ignored). */
  raw: string;
  /** Normalised form (see `normalizeText`), possessive `'s` removed. */
  norm: string;
  kind: TokenKind;
  /** Position in the question (index into the token list). */
  index: number;
  /** The token was written with a possessive `'s` ("Ezzat's"). */
  possessive?: boolean;
}

// A number (with decimals and an optional %), a word (letters, digits and
// inner apostrophes), or a single punctuation/symbol character.
const TOKEN_RE = /(\d+(?:[.,]\d+)?%?)|([\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*)|([^\s\p{L}\p{M}\p{N}])/gu;
const PUNCT = new Set([",", "?", "!", ";", ":", ".", "(", ")", "[", "]", "\"", "«", "»", "،", "؟", "؛"]);

/**
 * Split a question into tokens. Hyphens and slashes between letters separate
 * words ("penicillin-allergic", "calcipotriol/betamethasone"); between numbers
 * a hyphen is kept as a range symbol ("20-30").
 */
export function tokenize(text: string): Token[] {
  const source = toAsciiDigits(text);
  const tokens: Token[] = [];
  for (const m of source.matchAll(TOKEN_RE)) {
    const raw = m[0];
    if (m[1]) {
      tokens.push({ raw, norm: raw.replace(",", "."), kind: "number", index: tokens.length });
      continue;
    }
    if (m[2]) {
      let norm = normalizeText(raw);
      let possessive = false;
      if (/'s$/.test(norm) && norm.length > 3) {
        norm = norm.slice(0, -2);
        possessive = true;
      } else if (/s'$/.test(norm)) {
        norm = norm.slice(0, -1);
        possessive = true;
      }
      // An Arabic "and" written onto a number ("بين 20 و30").
      const anded = /^و(\d+)$/.exec(norm);
      if (anded) {
        tokens.push({ raw: "و", norm: "و", kind: "word", index: tokens.length });
        tokens.push({ raw: anded[1]!, norm: anded[1]!, kind: "number", index: tokens.length });
        continue;
      }
      // An Arabic article or preposition written onto a number ("ال40", "ب20").
      const prefixed = /^(?:ال|بال|لل|ب|ل)(\d+)$/.exec(norm);
      if (prefixed) {
        tokens.push({ raw, norm: prefixed[1]!, kind: "number", index: tokens.length });
        continue;
      }
      // Split letter/digit runs written together ("20mg", "40yo") into a number and a word.
      const split = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(norm);
      if (split) {
        tokens.push({ raw: split[1]!, norm: split[1]!, kind: "number", index: tokens.length });
        tokens.push({ raw: split[2]!, norm: split[2]!, kind: "word", index: tokens.length });
        continue;
      }
      tokens.push({ raw, norm, kind: "word", index: tokens.length, ...(possessive ? { possessive } : {}) });
      continue;
    }
    const ch = normalizeText(raw);
    if (PUNCT.has(raw) || PUNCT.has(ch)) {
      tokens.push({ raw, norm: ch, kind: "punct", index: tokens.length });
    } else if (ch === "-" || ch === "/" || ch === "–" || ch === "—") {
      // Kept only between two numbers (a range); elsewhere it just separates words.
      const prev = tokens[tokens.length - 1];
      if (prev?.kind === "number") tokens.push({ raw, norm: "-", kind: "symbol", index: tokens.length });
    } else {
      tokens.push({ raw, norm: ch, kind: "symbol", index: tokens.length });
    }
  }
  // Drop a range hyphen that is not followed by a number.
  return tokens
    .filter((t, i, all) => !(t.kind === "symbol" && t.norm === "-" && all[i + 1]?.kind !== "number"))
    .map((t, i) => ({ ...t, index: i }));
}

/** Normalised word tokens of a phrase (for vocabulary entries and chart text). */
export function words(text: string): string[] {
  return tokenize(text)
    .filter((t) => t.kind === "word" || t.kind === "number")
    .map((t) => t.norm);
}

const AR_PREFIXES = ["وبال", "وال", "بال", "فال", "كال", "لل", "ال"];

/**
 * Spelling variants of one normalised word used for matching: the word
 * itself, without a leading Arabic "و" (and), without the article or an
 * attached preposition (ال، بال، لل…), and the English singular.
 */
export function variants(word: string): string[] {
  const cached = variantCache.get(word);
  if (cached) return cached;
  const result = computeVariants(word);
  if (variantCache.size > 20_000) variantCache.clear();
  variantCache.set(word, result);
  return result;
}

const variantCache = new Map<string, string[]>();

function computeVariants(word: string): string[] {
  const out = new Set<string>([word]);
  if (isArabic(word)) {
    const bases = [word];
    if (word.startsWith("و") && word.length > 3) bases.push(word.slice(1));
    for (const base of bases) {
      out.add(base);
      for (const p of AR_PREFIXES) {
        if (base.startsWith(p) && base.length - p.length >= 2) out.add(base.slice(p.length));
      }
      if ((base.startsWith("ب") || base.startsWith("ل")) && base.length > 3) out.add(base.slice(1));
    }
  } else if (/^[a-z]+$/.test(word) && word.length > 3) {
    if (word.endsWith("ies") && word.length > 4) out.add(`${word.slice(0, -3)}y`);
    else if (/(ches|shes|xes|sses)$/.test(word)) out.add(word.slice(0, -2));
    else if (word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us") && !word.endsWith("is")) out.add(word.slice(0, -1));
  }
  return [...out];
}

/**
 * Optimal-string-alignment edit distance (insertions, deletions,
 * substitutions and adjacent transpositions), stopping early once it exceeds
 * `max`.
 */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j]!;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Typos tolerated for a word of this length: none under 5 letters, one up to 7, two from 8. */
export function typoBudget(length: number, arabic = false): number {
  if (arabic) return length >= 5 ? 1 : 0;
  if (length >= 8) return 2;
  if (length >= 5) return 1;
  return 0;
}

/**
 * Two normalised words are the same word: equal, equal after removing a
 * prefix/plural (`variants`), or within the typo budget with the same first
 * letter. Numbers must be equal.
 */
export function sameWord(a: string, b: string, opts: { fuzzy?: boolean } = {}): boolean {
  if (a === b) return true;
  if (/^\d/.test(a) || /^\d/.test(b)) return a === b;
  const va = variants(a);
  const vb = variants(b);
  for (const x of va) if (vb.includes(x)) return true;
  if (opts.fuzzy === false) return false;
  for (const x of va) {
    for (const y of vb) {
      if (x[0] !== y[0]) continue;
      const budget = typoBudget(Math.min(x.length, y.length), isArabic(x));
      if (budget > 0 && editDistance(x, y, budget) <= budget) return true;
    }
  }
  return false;
}

/**
 * Two spellings of the same personal name: equal after collapsing doubled
 * letters ("Ezat"/"Ezzat", "Mohamed"/"Mohammed"), or one letter apart from four
 * letters up ("Tarik"/"Tarek", "Ahmad"/"Ahmed"), two from eight.
 */
export function sameName(a: string, b: string): boolean {
  if (a === b) return true;
  if (/^\d/.test(a) || /^\d/.test(b)) return false;
  const collapse = (s: string) => s.replace(/(.)\1+/g, "$1");
  if (collapse(a) === collapse(b)) return true;
  if (a[0] !== b[0]) return false;
  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return false;
  const budget = shortest >= 8 ? 2 : 1;
  return editDistance(collapse(a), collapse(b), budget) <= budget || editDistance(a, b, budget) <= budget;
}

/** Same word without typo tolerance (prefix/plural variants only). */
export function sameWordExact(a: string, b: string): boolean {
  return sameWord(a, b, { fuzzy: false });
}

/**
 * Where `phrase` occurs in `text` as consecutive words (word-boundary match,
 * with `sameWord` equality). Returns the start index or -1.
 */
export function findPhrase(text: string[], phrase: string[], opts: { fuzzy?: boolean } = {}): number {
  if (!phrase.length || phrase.length > text.length) return -1;
  outer: for (let i = 0; i + phrase.length <= text.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (!sameWord(text[i + j]!, phrase[j]!, opts)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Collapse whitespace and trim a display string. */
export function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** "a, b or c" / "a, b and c". */
export function joinList(items: string[], conjunction: "or" | "and" | "أو" | "و" = "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  if (conjunction === "أو" || conjunction === "و") return items.join(` ${conjunction} `);
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

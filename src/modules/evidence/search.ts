import { normalizeText } from "@/modules/assistant/text";
import { CONCEPTS } from "@/modules/assistant/vocabulary";

/**
 * Finding the passages that answer a question, in English or Arabic, by the
 * words they share (BM25 over the clinic's approved passages, which are few
 * enough to score in memory). A drug or condition named any way the clinic's
 * vocabulary knows (a brand, the Arabic name) also counts as its generic name,
 * so "روكيوتان مع الدوكسي" finds the English passage on isotretinoin and
 * doxycycline.
 */

const STOP = new Set([
  // English
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "without", "is", "are", "was", "were", "be", "been", "can", "could",
  "should", "would", "may", "might", "must", "do", "does", "did", "i", "we", "you", "he", "she", "it", "they", "this", "that", "these",
  "those", "what", "which", "who", "how", "when", "where", "why", "if", "than", "then", "there", "their", "his", "her", "its", "our", "my",
  "at", "by", "from", "as", "about", "into", "patient", "patients", "use", "using", "used", "give", "given", "take", "taken", "any", "all", "not", "no",
  "have", "has", "had", "need", "needs", "needed", "ok", "okay",
  // Arabic (normalised: ة→ه, أ/إ→ا)
  "في", "من", "على", "علي", "عن", "الى", "الي", "مع", "و", "او", "هل", "ما", "ماذا", "ايه", "اي", "ده", "دي", "دا", "هو", "هي", "انا",
  "احنا", "انت", "لو", "ممكن", "يعني", "كده", "بس", "اللي", "الذي", "التي", "ان", "انه", "كان", "يكون", "عند", "لل", "ال", "مريض", "المريض",
  "العيان", "اقدر", "اديله", "اديها", "استخدم",
]);

/** A word as the index keeps it: Arabic article and common endings off, English plurals and -ing off. */
export function stem(word: string): string {
  let w = word;
  if (/[؀-ۿ]/.test(w)) {
    if (w.length > 4 && w.startsWith("ال")) w = w.slice(2);
    else if (w.length > 4 && (w.startsWith("بال") || w.startsWith("وال") || w.startsWith("لل"))) w = w.slice(3).replace(/^ل/, "");
    if (w.length > 4 && /(ات|ين|ون|ها|هم)$/.test(w)) w = w.slice(0, -2);
    return w;
  }
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  // "pregnancy" and "pregnant", "difference" and "different" alike.
  if (w.length > 6 && /(an|en)(cy|ce)$/.test(w)) return w.slice(0, -2);
  if (w.length > 6 && /(an|en)t$/.test(w)) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ed") && !w.endsWith("eed")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

interface Name {
  concept: string;
  words: string[];
}

type ConceptKind = "drug" | "condition" | "procedure";

let NAMES: { names: Name[]; phrases: Map<string, string[][]>; kinds: Map<string, ConceptKind> } | null = null;
/**
 * Every name the vocabulary knows for a drug, condition or procedure, as
 * words; and each one's phrases as the index keeps them, the generic name
 * first, so an English question finds an Arabic passage too.
 */
function vocabulary(): NonNullable<typeof NAMES> {
  if (!NAMES) {
    const concepts = CONCEPTS.filter((c) => c.kind === "drug" || c.kind === "condition" || c.kind === "procedure");
    NAMES = {
      names: concepts.flatMap((c) => c.names.map((n) => ({ concept: c.id, words: normalizeText(n).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean) }))),
      phrases: new Map(
        concepts.map((c) => {
          // "hair loss (any alopecia)": the label without its note.
          const all = [c.label.replace(/\s*\([^)]*\)/g, ""), ...c.names].map((n) => tokenize(n)).filter((p) => p.length);
          return [c.id, all.filter((p, i) => all.findIndex((q) => q.join(" ") === p.join(" ")) === i)];
        }),
      ),
      kinds: new Map(concepts.map((c) => [c.id, c.kind as ConceptKind])),
    };
  }
  return NAMES;
}

/**
 * One thing the question asks about: a word, or a drug, condition or
 * procedure it names. A passage speaks of it when it holds every word of one
 * of its phrases (the generic name, or the name as the question gave it).
 */
export interface QuestionUnit {
  /** The generic name first, then every other name the vocabulary knows (and the one the question used). */
  phrases: string[][];
  /** A drug, condition or procedure (the passage must speak of one of them). */
  concept: boolean;
  /** Which, for a concept: a question naming a drug is about that drug first. */
  kind?: ConceptKind;
}

export interface QuestionTerms {
  /** Every word to score with: the question's own, plus the generic name of whatever it names another way. */
  terms: string[];
  /** What the question asks about, each counted once however it is named. */
  units: QuestionUnit[];
}

export function analyzeQuestion(question: string): QuestionTerms {
  const words = normalizeText(question).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const { names, phrases, kinds } = vocabulary();
  const concepts = new Map<string, { phrases: string[][]; spans: [number, number][] }>();
  const named = new Set<string>();
  for (const n of names) {
    if (!n.words.length || !phrases.get(n.concept)?.length) continue;
    for (let i = 0; i + n.words.length <= words.length; i += 1) {
      // A name matches whole words; an Arabic name also with the article or a "و"/"بـ" before it.
      const hit = n.words.every((w, j) => {
        const q = words[i + j]!;
        return q === w || (j === 0 && /[؀-ۿ]/.test(w) && (q === `ال${w}` || q === `و${w}` || q === `ب${w}` || q === `وال${w}` || q === `بال${w}`));
      });
      if (!hit) continue;
      const asGiven = tokenize(words.slice(i, i + n.words.length).join(" "));
      const found = concepts.get(n.concept) ?? { phrases: [...phrases.get(n.concept)!], spans: [] };
      if (asGiven.length && !found.phrases.some((p) => p.join(" ") === asGiven.join(" "))) found.phrases.push(asGiven);
      found.spans.push([i, i + n.words.length]);
      concepts.set(n.concept, found);
      for (const t of asGiven) named.add(t);
      break;
    }
  }
  // A name inside a longer one ("hair loss" in "female pattern hair loss", "الحمل" in "حبوب منع الحمل") is the longer one's.
  const inside = ([a, b]: [number, number], self: string) =>
    [...concepts].some(([id, o]) => id !== self && o.spans.some(([c, d]) => c <= a && b <= d && d - c > b - a));
  const conceptUnits = [...concepts].filter(([id, c]) => !c.spans.every((s) => inside(s, id))).map(([id, c]) => ({ phrases: c.phrases, concept: true, kind: kinds.get(id) }));
  const plain = [...new Set(tokenize(question).filter((t) => !named.has(t)))];
  const units: QuestionUnit[] = [...plain.map((t) => ({ phrases: [[t]], concept: false })), ...conceptUnits];
  const terms = [...new Set(units.flatMap((u) => u.phrases.flat()))];
  return { terms, units };
}

/** The passage speaks of the unit: it holds every word of one of its phrases. */
export function speaksOf(unit: QuestionUnit, matched: readonly string[]): boolean {
  return unit.phrases.some((p) => p.every((t) => matched.includes(t)));
}

export interface Searchable {
  id: string;
  text: string;
}

export interface Scored<T> {
  item: T;
  score: number;
  /** The question's terms the passage contains. */
  matched: string[];
}

const K1 = 1.2;
const B = 0.75;

/** BM25 of each passage for the question's terms; the best first, only those sharing a term. */
export function rank<T extends Searchable>(items: T[], terms: string[]): Scored<T>[] {
  if (!items.length || !terms.length) return [];
  const docs = items.map((item) => {
    const tokens = tokenize(item.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { item, tf, length: tokens.length };
  });
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, docs.filter((d) => d.tf.has(t)).length);
  const n = docs.length;
  const out: Scored<T>[] = [];
  for (const d of docs) {
    let score = 0;
    const matched: string[] = [];
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched.push(t);
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avg));
    }
    if (matched.length) out.push({ item: d.item, score, matched });
  }
  return out.sort((a, b) => b.score - a.score || b.matched.length - a.matched.length);
}

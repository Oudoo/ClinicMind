import type { ClinicalExtraction, SummaryMention } from "./types";
import { normaliseClinicalTerm } from "./normalise";
import { baseMedicationName, identifyMedication } from "./safety/identify";

/**
 * The signed summary must match what was signed (audit #02). When the
 * clinician removes a diagnosis or a medication from the AI draft, the AI
 * summary may still mention it; these helpers find such mentions and rebuild
 * a summary from the signed items alone. Pure and client-safe: the review
 * panel highlights the same mentions the server refuses to sign.
 */

type Medication = ClinicalExtraction["medications"][number];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Arabic spelling variants the normaliser folds together (أإآ/ا, ة/ه, ى/ي). */
function letterClass(ch: string): string {
  if (ch === "ا") return "[اأإآٱ]";
  if (ch === "ه") return "[هة]";
  if (ch === "ي") return "[يى]";
  return escapeRegExp(ch);
}

/** Whole-word, case-insensitive pattern in any script (a letter or digit on either side continues a word). */
function termPattern(term: string): RegExp {
  const words = term
    .trim()
    .split(/\s+/)
    .map((word) => [...word].map(letterClass).join(""))
    .join("\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?![\\p{L}\\p{N}])`, "giu");
}

function rangesOf(text: string, term: string): [number, number][] {
  if (!term.trim()) return [];
  const out: [number, number][] = [];
  for (const m of text.matchAll(termPattern(term))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/** Words that name a medication in prose: its name without strength or form, and its generic(s). */
function medicationTerms(med: Medication): string[] {
  const terms = new Set<string>();
  const base = baseMedicationName(med.name);
  if (base) terms.add(base);
  for (const ingredient of identifyMedication(med).ingredients) {
    terms.add(ingredient.name.toLowerCase().replace(/\s*\(.*\)$/, ""));
  }
  return [...terms].filter((t) => t.length >= 3);
}

/**
 * Diagnoses and medications that were in the AI draft, are no longer in the
 * reviewed extraction, and are still mentioned in the summary. A medication
 * counts as kept when any signed line has the same generic ("Minoxidil 5%"
 * for "Minoxidil 5% solution"); words inside a signed item ("acne" within a
 * signed "acne vulgaris") are not mentions.
 */
export function findSummaryMentions(input: {
  draft: ClinicalExtraction;
  signed: ClinicalExtraction;
  summary: string;
}): SummaryMention[] {
  const { draft, signed, summary } = input;
  if (!summary.trim()) return [];

  const signedGenerics = new Set<string>();
  const signedNames = new Set<string>();
  for (const med of signed.medications) {
    const id = identifyMedication(med);
    for (const ingredient of id.ingredients) signedGenerics.add(ingredient.key);
    signedNames.add(id.baseName);
  }
  const removedMedications = draft.medications.filter((med) => {
    const id = identifyMedication(med);
    return id.ingredients.length ? !id.ingredients.some((i) => signedGenerics.has(i.key)) : !signedNames.has(id.baseName);
  });
  const signedDiagnoses = new Set(signed.diagnoses.map(normaliseClinicalTerm));
  const removedDiagnoses = draft.diagnoses.filter((d) => !signedDiagnoses.has(normaliseClinicalTerm(d)));
  if (!removedMedications.length && !removedDiagnoses.length) return [];

  const kept = [...signed.diagnoses, ...signed.medications.flatMap(medicationTerms)].flatMap((t) => rangesOf(summary, t));
  const outsideKept = ([start, end]: [number, number]) => !kept.some(([s, e]) => start >= s && end <= e);

  const mentions: SummaryMention[] = [];
  const seen = new Set<string>();
  const add = (kind: SummaryMention["kind"], item: string, term: string) => {
    const ranges = rangesOf(summary, term).filter(outsideKept);
    const key = `${kind}|${normaliseClinicalTerm(item)}|${normaliseClinicalTerm(term)}`;
    if (!ranges.length || seen.has(key)) return;
    seen.add(key);
    mentions.push({ kind, item, term, ranges });
  };
  for (const med of removedMedications) for (const term of medicationTerms(med)) add("medication", med.name, term);
  for (const diagnosis of removedDiagnoses) add("diagnosis", diagnosis, diagnosis.trim().replace(/\s+/g, " "));
  return mentions;
}

/** The summary cut into plain and highlighted pieces, for the review panel. */
export function highlightSegments(summary: string, mentions: readonly SummaryMention[]): { text: string; mark: boolean }[] {
  const ranges = mentions
    .flatMap((m) => m.ranges)
    .filter(([s, e]) => s >= 0 && e <= summary.length && e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: { text: string; mark: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (end <= cursor) continue;
    const from = Math.max(start, cursor);
    if (from > cursor) out.push({ text: summary.slice(cursor, from), mark: false });
    out.push({ text: summary.slice(from, end), mark: true });
    cursor = end;
  }
  if (cursor < summary.length) out.push({ text: summary.slice(cursor), mark: false });
  return out;
}

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ").replace(/[\s.;,:]+$/u, "");
  return t ? `${t}.` : "";
}

/** "Twice daily" → "twice daily"; abbreviations stay as written ("BID", "MRSA infection"). */
function lowerFirst(text: string): string {
  const firstWord = text.split(/\s+/)[0] ?? "";
  if (firstWord.length > 1 && firstWord === firstWord.toUpperCase()) return text;
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * A summary rebuilt from the signed extraction only — deterministic, no AI:
 * "<reason>. <diagnoses>. Plan: <medications with dose and frequency>. <follow-ups>."
 * The reason is the appointment's when there is one, else the presenting symptoms.
 */
export function rebuildSummary(extraction: ClinicalExtraction, opts: { reason?: string | null } = {}): string {
  const reason =
    opts.reason?.trim() ||
    (extraction.symptoms.length ? `Presented with ${extraction.symptoms.map(lowerFirst).join(", ")}` : "Consultation");
  const plan = extraction.medications.length
    ? `Plan: ${extraction.medications
        .map((m) => [m.name, m.dosage, m.frequency ? lowerFirst(m.frequency) : null].filter(Boolean).join(" "))
        .join("; ")}`
    : "Plan: no medication";
  return [
    sentence(reason),
    extraction.diagnoses.length ? sentence(extraction.diagnoses.join("; ")) : "",
    sentence(plan),
    ...extraction.followUps.map(sentence),
  ]
    .filter(Boolean)
    .join(" ");
}

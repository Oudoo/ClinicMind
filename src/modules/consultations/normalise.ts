import type { ClinicalExtraction } from "./types";

/**
 * Pure helpers shared by the server and the review editor, so both sides agree
 * on what counts as the same term and on what "nothing extracted" means. Safe
 * in client bundles: no database, no environment.
 */

/**
 * Canonical form of a clinical term for de-duplication: case-insensitive and
 * whitespace-normalised ("Type 2  Diabetes" ≡ "type 2 diabetes"). Used for
 * diagnosis de-duplication, medication reconciliation, duplicate chips and the
 * "edited from AI draft" count.
 */
export function normaliseClinicalTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isExtractionEmpty(e: ClinicalExtraction): boolean {
  return (
    e.symptoms.length === 0 &&
    e.diagnoses.length === 0 &&
    e.medications.length === 0 &&
    e.tests.length === 0 &&
    e.followUps.length === 0
  );
}

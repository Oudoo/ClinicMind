import type { ClinicalExtraction } from "./types";
import { baseMedicationName, medicationKey } from "./safety/identify";

/**
 * Pure helpers shared by the server and the review editor, so both sides agree
 * on what counts as the same term and on what "nothing extracted" means. Safe
 * in client bundles: no database, no environment.
 */

/**
 * Canonical form of a clinical term for de-duplication: case-insensitive and
 * whitespace-normalised ("Type 2  Diabetes" ≡ "type 2 diabetes"). Used for
 * diagnosis de-duplication, duplicate chips and the "edited from AI draft"
 * count. Medications use `medicationKey` instead.
 */
export function normaliseClinicalTerm(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Medication reconciliation key: strengths, dosage forms (solution, cream,
 * gel, tablets, %, mg…) and punctuation are dropped and brand names map to
 * their generic through the prescribing-safety knowledge table, so
 * "Minoxidil 5%" ≡ "Minoxidil 5% solution" ≡ "Regaine" and "Roaccutane 20 mg"
 * ≡ "Isotretinoin". An oral and a topical form of one generic stay distinct.
 */
export { medicationKey, baseMedicationName };

export function isExtractionEmpty(e: ClinicalExtraction): boolean {
  return (
    e.symptoms.length === 0 &&
    e.diagnoses.length === 0 &&
    e.medications.length === 0 &&
    e.tests.length === 0 &&
    e.followUps.length === 0
  );
}

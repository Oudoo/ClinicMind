import { z } from "zod";
import { chatProvider, type TenantAiOverrides } from "./provider";
import { zOptionalText } from "@/lib/validation";
import { normaliseClinicalTerm } from "@/modules/consultations/normalise";

/**
 * Clinical extraction pipeline: transcript -> structured JSON. The structured
 * output is stored separately from the free-text transcript and is ALWAYS
 * presented to a clinician for review before anything is signed.
 *
 * The schema here is the single contract for a clinical extraction: the model's
 * draft is normalised into it (leniently — malformed output degrades to an
 * empty structure, never to an exception) and the clinician's reviewed version
 * is validated against it strictly when the consultation is signed.
 */

export const MAX_EXTRACTION_ITEMS = 50;
export const MAX_EXTRACTION_ITEM_LENGTH = 200;
export const MAX_MEDICATION_NAME_LENGTH = 120;
export const MAX_MEDICATION_FIELD_LENGTH = 80;

/** Blank strings in a list are noise (an emptied chip, a stray newline), not data. */
function dropBlankStrings(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((v) => !(typeof v === "string" && v.trim() === "")) : value;
}

const zItem = z.string().trim().min(1).max(MAX_EXTRACTION_ITEM_LENGTH);
const zItemList = z.preprocess(dropBlankStrings, z.array(zItem).max(MAX_EXTRACTION_ITEMS)).default([]);

export const MedicationSchema = z.object({
  name: z.string().trim().min(1).max(MAX_MEDICATION_NAME_LENGTH),
  dosage: zOptionalText(MAX_MEDICATION_FIELD_LENGTH),
  frequency: zOptionalText(MAX_MEDICATION_FIELD_LENGTH),
});

export const ClinicalExtractionSchema = z.object({
  symptoms: zItemList,
  diagnoses: zItemList,
  medications: z.array(MedicationSchema).max(MAX_EXTRACTION_ITEMS).default([]),
  tests: zItemList,
  followUps: zItemList,
});

export type ClinicalExtraction = z.infer<typeof ClinicalExtractionSchema>;
export type ExtractedMedication = ClinicalExtraction["medications"][number];

export const EXTRACTION_LIST_KEYS = ["symptoms", "diagnoses", "tests", "followUps"] as const;
export type ExtractionListKey = (typeof EXTRACTION_LIST_KEYS)[number];

export function emptyExtraction(): ClinicalExtraction {
  return { symptoms: [], diagnoses: [], medications: [], tests: [], followUps: [] };
}

export function isEmptyExtraction(e: ClinicalExtraction): boolean {
  return EXTRACTION_LIST_KEYS.every((k) => e[k].length === 0) && e.medications.length === 0;
}

export { normaliseClinicalTerm };

const SYSTEM_PROMPT = [
  "You are a clinical documentation assistant. You extract structured clinical data from the transcript of a consultation.",
  "",
  "Rules — follow every one of them:",
  "1. Record ONLY what is explicitly stated in the transcript. Never infer, assume, generalise or complete missing information.",
  "2. Diagnoses: include only diagnoses the clinician states. Do not derive a diagnosis from symptoms. If the clinician says a diagnosis is suspected or provisional, keep that wording.",
  "3. Medications: record the name exactly as stated. Include \"dosage\" and \"frequency\" ONLY when they are stated; otherwise omit the field. Never guess a dose or a schedule.",
  "4. \"symptoms\": complaints and findings the patient or clinician reports. \"tests\": investigations ordered or discussed. \"followUps\": follow-up instructions, referrals or review dates that were stated.",
  "5. Keep every item short (a few words), in the language of the transcript, and without duplicates.",
  "6. If the transcript contains no clinical content, return empty lists.",
  "7. Output a single JSON object and nothing else: no markdown, no code fences, no commentary before or after it.",
  "",
  "JSON shape:",
  '{"symptoms": string[], "diagnoses": string[], "medications": [{"name": string, "dosage"?: string, "frequency"?: string}], "tests": string[], "followUps": string[]}',
].join("\n");

export interface ExtractionResult {
  data: ClinicalExtraction;
  raw: string;
  provider: string;
  model: string;
  latencyMs: number;
  /**
   * True when no structured data could be obtained: the model's output was not
   * parseable JSON, or it parsed but contained no clinical items. The UI must
   * say so instead of presenting an empty review as if the transcript had
   * nothing in it.
   */
  empty: boolean;
}

export interface ExtractionOptions {
  /** The acting tenant's provider overrides (its own keys and models), when any. */
  tenantAi?: TenantAiOverrides;
}

export async function extractClinicalData(transcript: string, opts: ExtractionOptions = {}): Promise<ExtractionResult> {
  const provider = chatProvider(undefined, opts.tenantAi);
  const result = await provider.chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ],
    { jsonMode: true, temperature: 0 },
  );

  const parsed = parseClinicalExtraction(result.content);
  return {
    data: parsed.data,
    raw: result.content,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    empty: !parsed.parsed || isEmptyExtraction(parsed.data),
  };
}

/**
 * Parse a model response into a clinical extraction. Tolerates fenced
 * ```json blocks and prose around the object; anything that still fails to
 * parse yields an empty structure with `parsed: false`.
 */
export function parseClinicalExtraction(raw: string): { data: ClinicalExtraction; parsed: boolean } {
  const json = locateJsonObject(raw);
  if (json === null) return { data: emptyExtraction(), parsed: false };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { data: emptyExtraction(), parsed: false };
  }
  if (!isRecord(value)) return { data: emptyExtraction(), parsed: false };
  const result = ClinicalExtractionSchema.safeParse(sanitise(value));
  return result.success ? { data: result.data, parsed: true } : { data: emptyExtraction(), parsed: false };
}

/**
 * Normalise a stored or client-supplied extraction leniently: unknown shapes,
 * over-long entries and blanks are trimmed away rather than rejected. Use this
 * for data already in the database; request bodies go through
 * `ClinicalExtractionSchema` directly so invalid input is a 422.
 */
export function normaliseExtraction(value: unknown): ClinicalExtraction {
  if (!isRecord(value)) return emptyExtraction();
  const result = ClinicalExtractionSchema.safeParse(sanitise(value));
  return result.success ? result.data : emptyExtraction();
}

/** The first JSON object in a model response (fenced or bare), parsed; `null` when there is none. */
export function parseModelJsonObject(raw: string): Record<string, unknown> | null {
  const json = locateJsonObject(raw);
  if (json === null) return null;
  try {
    const value: unknown = JSON.parse(json);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function locateJsonObject(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ").slice(0, max);
  return text.length ? text : undefined;
}

function sanitiseList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = cleanText(item, MAX_EXTRACTION_ITEM_LENGTH);
    if (!text) continue;
    const key = normaliseClinicalTerm(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_EXTRACTION_ITEMS) break;
  }
  return out;
}

function sanitiseMedications(value: unknown): ExtractedMedication[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedMedication[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    let med: ExtractedMedication | null = null;
    if (typeof item === "string") {
      const name = cleanText(item, MAX_MEDICATION_NAME_LENGTH);
      if (name) med = { name };
    } else if (isRecord(item)) {
      const name = cleanText(item.name, MAX_MEDICATION_NAME_LENGTH);
      if (name) {
        med = { name };
        const dosage = cleanText(item.dosage ?? item.dose, MAX_MEDICATION_FIELD_LENGTH);
        const frequency = cleanText(item.frequency, MAX_MEDICATION_FIELD_LENGTH);
        if (dosage) med.dosage = dosage;
        if (frequency) med.frequency = frequency;
      }
    }
    if (!med) continue;
    const key = normaliseClinicalTerm(med.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(med);
    if (out.length >= MAX_EXTRACTION_ITEMS) break;
  }
  return out;
}

function sanitise(value: Record<string, unknown>): ClinicalExtraction {
  return {
    symptoms: sanitiseList(value.symptoms),
    diagnoses: sanitiseList(value.diagnoses),
    medications: sanitiseMedications(value.medications),
    tests: sanitiseList(value.tests),
    followUps: sanitiseList(value.followUps ?? value.follow_ups),
  };
}

import { z } from "zod";
import { chatProvider, type TenantAiOverrides } from "./provider";
import { parseModelJsonObject } from "./extraction";
import { normaliseClinicalTerm } from "@/modules/consultations/normalise";

/**
 * Medical-history extraction: a dictated or typed note about the patient's
 * background -> the four history lists the record keeps (chronic conditions,
 * allergies, diagnoses, surgeries). The result is a SUGGESTION merged into the
 * history editor for the clinician to review; nothing is saved by this module.
 */
const MAX_ITEMS = 30;
const MAX_LENGTH = 120;

const zList = z.array(z.string().trim().min(1).max(MAX_LENGTH)).max(MAX_ITEMS).default([]);

export const HistoryExtractionSchema = z.object({
  chronicConditions: zList,
  allergies: zList,
  diagnoses: zList,
  surgeries: zList,
});
export type HistoryExtraction = z.infer<typeof HistoryExtractionSchema>;
export const HISTORY_KEYS = ["chronicConditions", "allergies", "diagnoses", "surgeries"] as const;

export function emptyHistoryExtraction(): HistoryExtraction {
  return { chronicConditions: [], allergies: [], diagnoses: [], surgeries: [] };
}

const SYSTEM_PROMPT = [
  "You are a clinical documentation assistant. From a doctor's note or dictation about a patient's background, extract the medical history as four lists.",
  "",
  "Rules:",
  "1. Record ONLY what is explicitly stated. Never infer a condition from a symptom or a medication.",
  '2. "chronicConditions": long-standing conditions (e.g. hypertension, hypothyroidism, atopic dermatitis). "allergies": drug, food or contact allergies (name the agent). "diagnoses": conditions diagnosed, past or present, that are not described as chronic. "surgeries": operations and procedures, with the year when stated.',
  "3. Negatives are not items: \"no allergies\" yields an empty allergies list. Family history is not the patient's history.",
  "4. Keep items short (a few words), in the language used, without duplicates. Write drug names in Latin script.",
  "5. Output a single JSON object and nothing else: no markdown, no commentary.",
  "",
  'JSON shape: {"chronicConditions": string[], "allergies": string[], "diagnoses": string[], "surgeries": string[]}',
].join("\n");

export interface HistoryExtractionResult {
  data: HistoryExtraction;
  raw: string;
  provider: string;
  model: string;
  latencyMs: number;
  /** True when nothing usable came back (unparseable output, offline provider, or no history stated). */
  empty: boolean;
}

export async function extractHistory(text: string, opts: { tenantAi?: TenantAiOverrides } = {}): Promise<HistoryExtractionResult> {
  const provider = chatProvider(undefined, opts.tenantAi);
  const result = await provider.chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    { jsonMode: true, temperature: 0 },
  );
  // The offline provider has no model behind it; its canned reply is never a history.
  const data = result.provider === "echo" ? emptyHistoryExtraction() : parseHistoryExtraction(result.content);
  return {
    data,
    raw: result.content,
    provider: result.provider,
    model: result.model,
    latencyMs: result.latencyMs,
    empty: HISTORY_KEYS.every((k) => data[k].length === 0),
  };
}

/** Lenient parse: unknown shapes degrade to empty lists, never to an exception. */
export function parseHistoryExtraction(raw: string): HistoryExtraction {
  const value = parseModelJsonObject(raw);
  if (!value) return emptyHistoryExtraction();
  const out = emptyHistoryExtraction();
  for (const key of HISTORY_KEYS) {
    const list = value[key] ?? value[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    for (const item of list) {
      if (typeof item !== "string") continue;
      const text = item.trim().replace(/\s+/g, " ").slice(0, MAX_LENGTH);
      if (!text) continue;
      const norm = normaliseClinicalTerm(text);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out[key].push(text);
      if (out[key].length >= MAX_ITEMS) break;
    }
  }
  const parsed = HistoryExtractionSchema.safeParse(out);
  return parsed.success ? parsed.data : emptyHistoryExtraction();
}

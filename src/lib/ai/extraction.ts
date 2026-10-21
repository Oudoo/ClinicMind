import { z } from "zod";
import { chatProvider } from "./provider";

/**
 * Clinical extraction pipeline: transcript -> structured JSON. The structured
 * output is stored separately from the free-text transcript and is ALWAYS
 * presented to a clinician for review before anything is signed.
 */

export const ClinicalExtractionSchema = z.object({
  symptoms: z.array(z.string()).default([]),
  diagnoses: z.array(z.string()).default([]),
  medications: z
    .array(
      z.object({
        name: z.string(),
        dosage: z.string().optional(),
        frequency: z.string().optional(),
      }),
    )
    .default([]),
  tests: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
});

export type ClinicalExtraction = z.infer<typeof ClinicalExtractionSchema>;

const EMPTY: ClinicalExtraction = {
  symptoms: [],
  diagnoses: [],
  medications: [],
  tests: [],
  followUps: [],
};

export async function extractClinicalData(transcript: string): Promise<{
  data: ClinicalExtraction;
  raw: string;
  provider: string;
  model: string;
}> {
  const provider = chatProvider();
  const system = {
    role: "system" as const,
    content: [
      "You extract structured clinical data from a consultation transcript.",
      "Return ONLY valid JSON matching this shape:",
      '{ "symptoms": string[], "diagnoses": string[], "medications": [{"name": string, "dosage"?: string, "frequency"?: string}], "tests": string[], "followUps": string[] }',
      "Do not infer beyond the transcript. Omit anything not explicitly stated.",
    ].join("\n"),
  };

  const result = await provider.chat([system, { role: "user", content: transcript }], {
    jsonMode: true,
    temperature: 0,
  });

  return {
    data: safeParse(result.content),
    raw: result.content,
    provider: result.provider,
    model: result.model,
  };
}

function safeParse(raw: string): ClinicalExtraction {
  try {
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) return EMPTY;
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    return ClinicalExtractionSchema.parse(parsed);
  } catch {
    return EMPTY;
  }
}

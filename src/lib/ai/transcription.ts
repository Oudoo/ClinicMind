import type { TranscribeOptions } from "./types";

/**
 * Shared instructions for speech-to-text through a multimodal model (Gemini)
 * and the style prompt for dedicated transcription endpoints (OpenAI). The
 * clinic's reality is Egyptian Arabic and English in the same sentence, so the
 * rule is: keep every language as it was spoken, never translate, never
 * summarise, and keep drug names and doses in Latin script with digits.
 */
export const DEFAULT_GLOSSARY = [
  "minoxidil",
  "finasteride",
  "dutasteride",
  "isotretinoin",
  "tretinoin",
  "adapalene",
  "doxycycline",
  "tranexamic acid",
  "hydroquinone",
  "triamcinolone",
  "PRP",
  "FUE",
  "trichoscopy",
  "melasma",
  "alopecia areata",
  "androgenetic alopecia",
];

export function transcriptionInstructions(opts: TranscribeOptions): string {
  const glossary = [...new Set([...(opts.glossary ?? []), ...DEFAULT_GLOSSARY])];
  const language =
    opts.language === "ar"
      ? "The speech is mainly Arabic (Egyptian dialect), with English medical terms."
      : opts.language === "en"
        ? "The speech is mainly English, possibly with Arabic phrases."
        : "The speech may mix Egyptian Arabic and English within a sentence.";
  return [
    "Transcribe this clinical audio verbatim.",
    language,
    "Keep each language exactly as spoken: Arabic (including Egyptian dialect) in Arabic script, English in Latin script. Never translate, paraphrase or summarise.",
    "Write drug names, doses and units in Latin script with digits, for example: minoxidil 5%, 250 mg, twice daily.",
    opts.speakers
      ? 'Two people may speak. Put each turn on its own line, prefixed "Doctor:" or "Patient:". If only one person speaks, use no prefixes.'
      : "One person is dictating. Do not add speaker labels.",
    "Return the transcript text only: no commentary, headings, timestamps or markdown. If there is no intelligible speech, return nothing.",
    `Preferred vocabulary: ${glossary.join(", ")}.`,
  ].join("\n");
}

/** Short style prompt for endpoints that accept a text hint instead of full instructions. */
export function transcriptionPrompt(opts: TranscribeOptions): string {
  const glossary = [...new Set([...(opts.glossary ?? []), ...DEFAULT_GLOSSARY])];
  return `Clinical ${opts.speakers ? "consultation between a doctor and a patient" : "dictation by a doctor"} in Egyptian Arabic and English. Arabic in Arabic script, English in Latin script, drug names and doses with digits. Vocabulary: ${glossary.join(", ")}.`;
}

/** File extension for the multipart upload, from the container type. */
export function audioExtension(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/webm":
    case "video/webm":
      return "webm";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/flac":
      return "flac";
    default:
      return "bin";
  }
}

/** Audio containers the transcribe endpoint accepts (what browsers record, plus common uploads). */
export const ACCEPTED_AUDIO_TYPES: ReadonlySet<string> = new Set([
  "audio/webm",
  "video/webm",
  "audio/mp4",
  "audio/x-m4a",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/flac",
]);

/** The container type without codec parameters, lower-cased; `null` when unsupported. */
export function normaliseAudioType(mimeType: string | null | undefined): string | null {
  const base = (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return ACCEPTED_AUDIO_TYPES.has(base) ? base : null;
}

/** Upload ceiling: 15 MB keeps inline Gemini requests under their 20 MB limit with headroom for base64. */
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

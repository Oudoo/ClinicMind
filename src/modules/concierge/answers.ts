import { z } from "zod";
import { dayLabel, stepHeading, type Language, type ProtocolQuestion, type ProtocolStep } from "./protocols";
import type { AnswerMap, TriageLevel } from "./triage";

/**
 * Answers to a check-in: the validation schema built from the step's
 * questions, display formatting and the one-line summary written to the
 * patient timeline. Pure.
 */

const MAX_TEXT_ANSWER = 500;

function questionSchema(q: ProtocolQuestion): z.ZodTypeAny {
  switch (q.type) {
    case "yesno":
      return z.preprocess(
        (v) => (v === "yes" || v === "true" || v === 1 || v === "1" ? true : v === "no" || v === "false" || v === 0 || v === "0" ? false : v),
        z.boolean({ error: "Answer yes or no" }),
      );
    case "scale": {
      const min = q.min ?? 0;
      const max = q.max ?? 10;
      return z.coerce.number({ error: "Choose a value" }).int().min(min, `At least ${min}`).max(max, `At most ${max}`);
    }
    case "number": {
      let s = z.coerce.number({ error: "Enter a number" });
      if (q.min !== undefined) s = s.min(q.min, `At least ${q.min}`);
      if (q.max !== undefined) s = s.max(q.max, `At most ${q.max}`);
      return s;
    }
    default:
      return z.string().trim().max(MAX_TEXT_ANSWER);
  }
}

/**
 * Zod schema of the `answers` object for a step: every yes/no, scale and number
 * question is required, text questions are optional. Keys the step does not
 * know are dropped.
 */
export function answersSchema(step: Pick<ProtocolStep, "questions">, opts: { required?: boolean } = {}) {
  const required = opts.required ?? true;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const q of step.questions ?? []) {
    const base = questionSchema(q);
    shape[q.key] = q.type === "text" || !required ? base.optional() : base;
  }
  return z.object(shape).strip();
}

/** "yes" / "3/10" / "12" / the text, in the given language. */
export function formatAnswer(q: ProtocolQuestion, value: unknown, language: Language = "en"): string {
  if (value === undefined || value === null || value === "") return "—";
  if (q.type === "yesno") {
    const yes = value === true || value === "yes" || value === "true";
    return language === "ar" ? (yes ? "نعم" : "لا") : yes ? "yes" : "no";
  }
  if (q.type === "scale") return `${value}/${q.max ?? 10}`;
  return String(value);
}

/** "pain 3/10, swelling yes, bleeding no" — English, for the record. */
export function summarizeAnswers(step: Pick<ProtocolStep, "questions">, answers: AnswerMap): string {
  return (step.questions ?? [])
    .filter((q) => answers[q.key] !== undefined && answers[q.key] !== null && answers[q.key] !== "")
    .map((q) => `${q.key} ${formatAnswer(q, answers[q.key])}`)
    .join(", ");
}

export const TRIAGE_LABEL: Record<TriageLevel, string> = { OK: "OK", WATCH: "Watch", HIGH_RISK: "High risk" };

/** The timeline line: "Day 1 check-in: pain 3/10, bleeding no · satisfaction 5/5 · OK". */
export function summarizeCheckIn(
  step: ProtocolStep,
  input: { answers: AnswerMap; satisfaction?: number | null; photoCount?: number; triage: TriageLevel },
): string {
  const parts: string[] = [];
  const answers = summarizeAnswers(step, input.answers);
  if (answers) parts.push(answers);
  if (input.photoCount) parts.push(`${input.photoCount} photo${input.photoCount === 1 ? "" : "s"}`);
  if (input.satisfaction) parts.push(`satisfaction ${input.satisfaction}/5`);
  parts.push(TRIAGE_LABEL[input.triage]);
  return `${stepHeading(step, "en")}: ${parts.join(" · ")}`;
}

/** "No answer to the day-7 check-in" */
export function missedSummary(step: ProtocolStep): string {
  return `No answer to the ${dayLabel(step, "en").toLowerCase()} ${step.kind === "PHOTO_REQUEST" ? "photo request" : "check-in"}`;
}

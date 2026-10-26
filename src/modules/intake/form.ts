import { z } from "zod";
import { zOptionalText, zText } from "@/lib/validation";
import { canonicalPhone, normalizeDigits, normalizeNationalId } from "@/modules/patients/search";

/**
 * What a patient fills in on the public onboarding form. The same schema
 * validates the public POST, is stored (as its parsed output) in
 * `IntakeSubmission.data`, and is parsed back when reception accepts the
 * submission. Every text is bounded; phones are canonicalised to `+2010…`;
 * dates stay `YYYY-MM-DD` strings so the JSON round-trips unchanged.
 */
export const INTAKE_LANGUAGES = ["ar", "en"] as const;
export type IntakeLanguage = (typeof INTAKE_LANGUAGES)[number];

export const INTAKE_GENDERS = ["MALE", "FEMALE", "OTHER", "UNDISCLOSED"] as const;

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

/** A phone typed by a patient, in any spelling; stored canonical. */
export const zIntakePhone = z
  .string()
  .trim()
  .max(30)
  .transform((value, ctx) => {
    const canonical = canonicalPhone(value);
    if (!canonical) {
      ctx.addIssue({ code: "custom", message: "Invalid phone number" });
      return z.NEVER;
    }
    return canonical;
  });

const zOptionalPhone = z.preprocess(blank, zIntakePhone.optional());

const zDateKey = z
  .string()
  .trim()
  .transform((s) => normalizeDigits(s))
  .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"))
  .refine((s) => {
    const t = Date.parse(`${s}T00:00:00.000Z`);
    return !Number.isNaN(t) && t <= Date.now() && t > Date.UTC(1900, 0, 1);
  }, "Invalid date of birth");

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim().replace(/\s+/g, " ");
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

const zChipList = z.array(z.string().trim().max(120)).max(30).transform(dedupe).default([]);

export const IntakeMedicationInput = z.object({
  name: zText(120).min(1),
  dose: zOptionalText(80),
});

export const IntakeFormInput = z.object({
  language: z.enum(INTAKE_LANGUAGES).default("ar"),
  // 1 · personal
  fullName: zText(120).min(2, "Full name is required"),
  phone: zIntakePhone,
  whatsappSame: z.boolean().default(true),
  whatsapp: zOptionalPhone,
  dateOfBirth: z.preprocess(blank, zDateKey.optional()),
  gender: z.enum(INTAKE_GENDERS).default("UNDISCLOSED"),
  city: zOptionalText(80),
  nationalId: z.preprocess(
    (v) => (typeof v === "string" ? normalizeNationalId(v) || undefined : v),
    zText(40).optional(),
  ),
  // 2 · contact
  email: z.preprocess(blank, z.string().trim().toLowerCase().max(254).email("Invalid e-mail address").optional()),
  address: zOptionalText(300),
  emergencyContactName: zOptionalText(120),
  emergencyContactPhone: zOptionalPhone,
  emergencyContactRelation: zOptionalText(60),
  // 3 · what brings you
  treatmentKeys: z.array(zText(60)).max(5).default([]),
  concern: zOptionalText(1000),
  sinceWhen: zOptionalText(120),
  // 4 · medical history
  chronicConditions: zChipList,
  allergies: zChipList,
  medications: z.array(IntakeMedicationInput).max(30).default([]),
  surgeries: zChipList,
  // 5 · consent
  consent: z.literal(true, { message: "Consent is required" }),
  whatsappUpdates: z.boolean().default(false),
});

export type IntakeForm = z.output<typeof IntakeFormInput>;
export type IntakeFormInput = z.input<typeof IntakeFormInput>;

/** The WhatsApp number the form resolves to (same as phone unless overridden). */
export function intakeWhatsapp(form: Pick<IntakeForm, "phone" | "whatsapp" | "whatsappSame">): string | null {
  return form.whatsappSame || !form.whatsapp ? form.phone : form.whatsapp;
}

/** One-line emergency contact for the patient record. */
export function intakeEmergencyContact(
  form: Pick<IntakeForm, "emergencyContactName" | "emergencyContactPhone" | "emergencyContactRelation">,
): string | null {
  const parts = [form.emergencyContactName, form.emergencyContactPhone].filter(Boolean);
  if (!parts.length) return null;
  const relation = form.emergencyContactRelation ? ` (${form.emergencyContactRelation})` : "";
  return `${parts.join(" · ")}${relation}`.slice(0, 200);
}

import type { ComponentProps } from "react";
import type { Badge } from "@/components/ui/primitives";
import { ApiError } from "@/lib/http";

/**
 * Types, labels and small helpers shared by the patient pages (server) and the
 * patient client components. Deliberately without a "use client" directive:
 * plain values exported from a client module are not readable on the server.
 */

export type PatientGender = "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED";
export type PatientLanguage = "ar" | "en";
export type BadgeTone = NonNullable<ComponentProps<typeof Badge>["tone"]>;

export const GENDER_LABELS: Record<PatientGender, string> = {
  MALE: "Male",
  FEMALE: "Female",
  OTHER: "Other",
  UNDISCLOSED: "Undisclosed",
};

export const LANGUAGE_LABELS: Record<PatientLanguage, string> = { ar: "Arabic", en: "English" };

export function isPatientLanguage(code: string): code is PatientLanguage {
  return code in LANGUAGE_LABELS;
}

export function languageLabel(code: string): string {
  return isPatientLanguage(code) ? LANGUAGE_LABELS[code] : code;
}

/**
 * Form state for the patient profile. Blank strings are sent as they are: the
 * API omits them on create and clears the column on edit.
 */
export interface PatientFormValues {
  fullName: string;
  gender: PatientGender;
  /** `YYYY-MM-DD` or blank. */
  dateOfBirth: string;
  phone: string;
  whatsapp: string;
  email: string;
  nationalId: string;
  city: string;
  language: PatientLanguage;
  emergencyContact: string;
  address: string;
  tags: string[];
  notes: string;
  /** Treatment reminders on WhatsApp (appointments, recalls). */
  reminderConsent: boolean;
  /** Offers and news, and the message after a year without a visit. */
  marketingConsent: boolean;
}

export const EMPTY_PATIENT_FORM: PatientFormValues = {
  fullName: "",
  gender: "UNDISCLOSED",
  dateOfBirth: "",
  phone: "",
  whatsapp: "",
  email: "",
  nationalId: "",
  city: "",
  language: "ar",
  emergencyContact: "",
  address: "",
  tags: [],
  notes: "",
  reminderConsent: true,
  marketingConsent: false,
};

export interface HistoryFormValues {
  chronicConditions: string[];
  allergies: string[];
  diagnoses: string[];
  surgeries: string[];
}

/** Serializable form values for an existing patient row (for the edit dialog). */
export function patientFormValues(patient: {
  fullName: string;
  gender: PatientGender;
  dateOfBirth: Date | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  nationalId?: string | null;
  city?: string | null;
  language: string;
  emergencyContact: string | null;
  address: string | null;
  tags: string[];
  notes: string | null;
  reminderConsent?: boolean;
  marketingConsent?: boolean;
}): PatientFormValues {
  return {
    fullName: patient.fullName,
    gender: patient.gender,
    dateOfBirth: patient.dateOfBirth ? patient.dateOfBirth.toISOString().slice(0, 10) : "",
    phone: patient.phone ?? "",
    whatsapp: patient.whatsapp ?? "",
    email: patient.email ?? "",
    nationalId: patient.nationalId ?? "",
    city: patient.city ?? "",
    language: isPatientLanguage(patient.language) ? patient.language : "ar",
    emergencyContact: patient.emergencyContact ?? "",
    address: patient.address ?? "",
    tags: patient.tags,
    notes: patient.notes ?? "",
    reminderConsent: patient.reminderConsent ?? true,
    marketingConsent: patient.marketingConsent ?? false,
  };
}

/** Human message for a failed `apiFetch`, for toasts and form banners. */
export function apiErrorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Could not reach the server. Please try again.";
}

// ── Dates of birth and age ────────────────────────────────────────────────────

/** Nobody on the registry is older than this (the API refuses an older date of birth). */
export const MAX_AGE_YEARS = 120;

/** `YYYY-MM-DD` of the oldest date of birth the form accepts (120 years before today, UTC like the stored dates). */
export function oldestDateOfBirth(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear() - MAX_AGE_YEARS, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
}

// ── Duplicate warnings ────────────────────────────────────────────────────────

export type DuplicateField = "phone" | "whatsapp" | "nationalId";

export interface DuplicateMatchView {
  id: string;
  fullName: string;
  field: DuplicateField;
}

export interface DuplicateInfo {
  code: "duplicate_phone" | "duplicate_national_id";
  matches: DuplicateMatchView[];
}

/** The 409 `duplicate_phone` / `duplicate_national_id` payload of the patient API, or null for any other error. */
export function duplicateInfo(err: unknown): DuplicateInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code !== "duplicate_phone" && err.code !== "duplicate_national_id") return null;
  const body = err.body as { matches?: DuplicateMatchView[] } | null;
  return { code: err.code, matches: Array.isArray(body?.matches) ? body.matches : [] };
}

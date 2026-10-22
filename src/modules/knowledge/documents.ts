import type { EmbeddingSource } from "@prisma/client";
import type { ChunkMetadata } from "@/lib/ai/rag";

/**
 * Plain-text document renderers for the RAG store.
 *
 * One document per entity, rendered as short "Label: values" lines so that a
 * chunk reads as a list of facts (the offline provider quotes these lines
 * verbatim; real models cite them). Renderers are pure functions of already
 * loaded rows, so the text they produce — and therefore the content hash — is
 * stable between runs. Dates are rendered as ISO dates for the same reason.
 */

export interface KnowledgeDocument {
  source: EmbeddingSource;
  /** Id of the source record (patient, visit, consultation, conversation). */
  refId: string;
  patientId: string | null;
  patientName: string | null;
  title: string;
  occurredAt: Date | null;
  kind: ChunkMetadata["kind"];
  text: string;
}

export interface PatientProfile {
  id: string;
  fullName: string;
  gender: "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED";
  dateOfBirth: Date | null;
  language: string;
  tags: string[];
  notes: string | null;
}

export interface HistoryInput {
  chronicConditions: unknown;
  allergies: unknown;
  surgeries: unknown;
  diagnoses: unknown;
  symptoms: unknown;
}

export interface MedicationInput {
  name: string;
  dosage: string | null;
  frequency: string | null;
  startDate: Date | null;
  endDate: Date | null;
  active: boolean;
  stoppedAt: Date | null;
  stopReason: string | null;
}

export interface AppointmentInput {
  startsAt: Date;
  status: string;
  reason: string | null;
}

export interface VisitInput {
  id: string;
  patientId: string;
  createdAt: Date;
  doctorName: string | null;
  summary: string | null;
  notes: string | null;
  transcript: string | null;
}

export interface ConsultationInput {
  id: string;
  patientId: string;
  createdAt: Date;
  reviewedAt: Date | null;
  summary: string | null;
  transcript: string | null;
  extraction: unknown;
}

export interface ConversationInput {
  id: string;
  patientId: string | null;
  channel: string;
  locale: string;
  createdAt: Date;
  summary: string | null;
  transcript: string | null;
  messages: { direction: "INBOUND" | "OUTBOUND"; body: string; createdAt: Date }[];
}

const NOTE_EXCERPT = 200;
const VISIT_TRANSCRIPT_EXCERPT = 1500;
const CONSULTATION_TRANSCRIPT_LIMIT = 8000;
const CONVERSATION_EXCERPT = 1500;
const CONVERSATION_MESSAGES = 10;

/** The patient's profile and medical history (`source = DIAGNOSIS`, refId = patientId). */
export function renderPatientHistoryDocument(
  patient: PatientProfile,
  history: HistoryInput | null,
  medications: MedicationInput[],
  upcoming: AppointmentInput[],
): KnowledgeDocument {
  const lines = [
    profileLine(patient),
    `Chronic conditions: ${listOrNone(history?.chronicConditions)}.`,
    `Allergies: ${listOrNone(history?.allergies)}.`,
    `Surgeries: ${listOrNone(history?.surgeries)}.`,
    `Diagnoses: ${listOrNone(history?.diagnoses)}.`,
  ];
  const symptoms = jsonList(history?.symptoms);
  if (symptoms.length) lines.push(`Symptoms: ${symptoms.join("; ")}.`);

  const active = medications.filter((m) => m.active && !m.stoppedAt);
  lines.push(`Active medications: ${active.length ? active.map(medicationSummary).join("; ") : "none recorded"}.`);

  const upcomingSorted = [...upcoming].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, 5);
  lines.push(
    `Upcoming appointments: ${
      upcomingSorted.length
        ? upcomingSorted
            .map((a) => `${isoDate(a.startsAt)}${a.reason ? ` (${a.reason}, ${a.status.toLowerCase()})` : ` (${a.status.toLowerCase()})`}`)
            .join("; ")
        : "none scheduled"
    }.`,
  );

  const note = oneLine(patient.notes, NOTE_EXCERPT);
  if (note) lines.push(`Notes: ${note}`);

  return {
    source: "DIAGNOSIS",
    refId: patient.id,
    patientId: patient.id,
    patientName: patient.fullName,
    title: "Profile & medical history",
    occurredAt: null,
    kind: "patient_history",
    text: lines.join("\n"),
  };
}

/** The patient's medication list (`source = MEDICATION`, refId = patientId). */
export function renderPatientMedicationsDocument(patient: PatientProfile, medications: MedicationInput[]): KnowledgeDocument {
  const active = medications.filter((m) => m.active && !m.stoppedAt);
  const stopped = medications
    .filter((m) => !m.active || m.stoppedAt)
    .sort((a, b) => (b.stoppedAt?.getTime() ?? 0) - (a.stoppedAt?.getTime() ?? 0))
    .slice(0, 5);

  const lines = [profileLine(patient), "Active medications:"];
  if (active.length) {
    for (const m of active) {
      lines.push(`- ${medicationSummary(m)}${m.startDate ? ` (since ${isoDate(m.startDate)})` : ""}`);
    }
  } else {
    lines.push("- none recorded");
  }
  if (stopped.length) {
    lines.push("Stopped medications:");
    for (const m of stopped) {
      const when = m.stoppedAt ?? m.endDate;
      lines.push(`- ${medicationSummary(m)}${when ? ` (stopped ${isoDate(when)}` : " (stopped"}${m.stopReason ? `: ${m.stopReason}` : ""})`);
    }
  }

  return {
    source: "MEDICATION",
    refId: patient.id,
    patientId: patient.id,
    patientName: patient.fullName,
    title: "Medications",
    occurredAt: null,
    kind: "patient_medications",
    text: lines.join("\n"),
  };
}

/** One visit (`source = VISIT_NOTE`, refId = visitId). */
export function renderVisitDocument(visit: VisitInput, patientName: string): KnowledgeDocument {
  const lines = [
    `Visit on ${isoDate(visit.createdAt)}${visit.doctorName ? ` with ${visit.doctorName}` : ""} for patient ${patientName}.`,
  ];
  const summary = visit.summary?.trim();
  const notes = visit.notes?.trim();
  if (summary) lines.push(`Summary: ${summary}`);
  if (notes && notes !== summary) lines.push(`Notes: ${notes}`);
  const transcript = oneLine(visit.transcript, VISIT_TRANSCRIPT_EXCERPT);
  if (transcript) lines.push(`Transcript excerpt: ${transcript}`);

  return {
    source: "VISIT_NOTE",
    refId: visit.id,
    patientId: visit.patientId,
    patientName,
    title: `Visit ${isoDate(visit.createdAt)}`,
    occurredAt: visit.createdAt,
    kind: "visit",
    text: lines.join("\n"),
  };
}

/** A signed consultation: structured extraction + summary + transcript (`source = TRANSCRIPT`). */
export function renderConsultationDocument(consultation: ConsultationInput, patientName: string): KnowledgeDocument {
  const occurredAt = consultation.reviewedAt ?? consultation.createdAt;
  const lines = [`Signed consultation on ${isoDate(occurredAt)} for patient ${patientName}.`];
  const summary = consultation.summary?.trim();
  if (summary) lines.push(`Summary: ${summary}`);

  const extraction = parseExtraction(consultation.extraction);
  if (extraction.symptoms.length) lines.push(`Symptoms: ${extraction.symptoms.join("; ")}.`);
  if (extraction.diagnoses.length) lines.push(`Diagnoses: ${extraction.diagnoses.join("; ")}.`);
  if (extraction.medications.length) lines.push(`Medications prescribed: ${extraction.medications.join("; ")}.`);
  if (extraction.tests.length) lines.push(`Tests ordered: ${extraction.tests.join("; ")}.`);
  if (extraction.followUps.length) lines.push(`Follow-ups: ${extraction.followUps.join("; ")}.`);

  const transcript = consultation.transcript?.trim();
  if (transcript) {
    lines.push("", "Transcript:", truncate(transcript, CONSULTATION_TRANSCRIPT_LIMIT));
  }

  return {
    source: "TRANSCRIPT",
    refId: consultation.id,
    patientId: consultation.patientId,
    patientName,
    title: `Consultation ${isoDate(occurredAt)}`,
    occurredAt,
    kind: "consultation",
    text: lines.join("\n"),
  };
}

/**
 * A conversation summary (`source = CONVERSATION`). Falls back to a transcript
 * excerpt or the last messages when no summary exists yet; returns null when
 * there is nothing to index.
 */
export function renderConversationDocument(conversation: ConversationInput, patientName: string | null): KnowledgeDocument | null {
  const summary = conversation.summary?.trim();
  const transcript = oneLine(conversation.transcript, CONVERSATION_EXCERPT);
  const recent = conversation.messages
    .slice()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-CONVERSATION_MESSAGES)
    .map((m) => `${m.direction === "INBOUND" ? "Patient" : "Clinic"}: ${oneLine(m.body, 300)}`)
    .filter((line) => !line.endsWith(": "));

  if (!summary && !transcript && !recent.length) return null;

  const lines = [
    `${channelLabel(conversation.channel)} conversation on ${isoDate(conversation.createdAt)}${
      patientName ? ` with patient ${patientName}` : " with an unidentified contact"
    } (${languageLabel(conversation.locale)}).`,
  ];
  if (summary) lines.push(`Summary: ${summary}`);
  else if (transcript) lines.push(`Transcript excerpt: ${transcript}`);
  else lines.push("Recent messages:", ...recent);

  return {
    source: "CONVERSATION",
    refId: conversation.id,
    patientId: conversation.patientId,
    patientName,
    title: `${channelLabel(conversation.channel)} ${isoDate(conversation.createdAt)}`,
    occurredAt: conversation.createdAt,
    kind: "conversation",
    text: lines.join("\n"),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function profileLine(patient: PatientProfile): string {
  const age = ageFrom(patient.dateOfBirth);
  const descriptors = [age !== null ? `${age}-year-old` : null, genderLabel(patient.gender)].filter(Boolean).join(" ");
  const parts = [`Patient: ${patient.fullName}${descriptors ? ` (${descriptors})` : ""}`];
  parts.push(`preferred language: ${languageLabel(patient.language)}`);
  const line = `${parts.join(", ")}.`;
  const tags = patient.tags.map((t) => t.trim()).filter(Boolean);
  return tags.length ? `${line} Tags: ${tags.join(", ")}.` : line;
}

export function medicationSummary(m: { name: string; dosage: string | null; frequency: string | null }): string {
  return [m.name.trim(), m.dosage?.trim(), m.frequency?.trim()].filter(Boolean).join(" ");
}

/** Read a JSON list column as strings, whether it holds strings or objects. */
export function jsonList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = labelOf(item);
    if (text) out.push(text);
  }
  return out;
}

function labelOf(item: unknown): string | null {
  if (item == null) return null;
  if (typeof item === "string") return item.trim() || null;
  if (typeof item === "number" || typeof item === "boolean") return String(item);
  if (typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const key of ["name", "label", "title", "value", "description", "text"]) {
      const v = o[key];
      if (typeof v === "string" && v.trim()) {
        const extras = ["dosage", "dose", "frequency", "date", "year", "status"]
          .map((k) => o[k])
          .filter((v2): v2 is string => typeof v2 === "string" && v2.trim().length > 0);
        return extras.length ? `${v.trim()} (${extras.join(", ")})` : v.trim();
      }
    }
    try {
      return JSON.stringify(item);
    } catch {
      return null;
    }
  }
  return null;
}

function listOrNone(value: unknown): string {
  const items = jsonList(value);
  return items.length ? items.join("; ") : "none recorded";
}

function parseExtraction(value: unknown): {
  symptoms: string[];
  diagnoses: string[];
  medications: string[];
  tests: string[];
  followUps: string[];
} {
  const o = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    symptoms: jsonList(o.symptoms),
    diagnoses: jsonList(o.diagnoses),
    medications: jsonList(o.medications),
    tests: jsonList(o.tests),
    followUps: jsonList(o.followUps),
  };
}

function genderLabel(gender: PatientProfile["gender"]): string | null {
  switch (gender) {
    case "MALE":
      return "male";
    case "FEMALE":
      return "female";
    case "OTHER":
      return "other gender";
    default:
      return null;
  }
}

function languageLabel(code: string): string {
  switch (code.toLowerCase()) {
    case "ar":
      return "Arabic";
    case "arz":
      return "Egyptian Arabic";
    case "en":
      return "English";
    default:
      return code;
  }
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "WHATSAPP":
      return "WhatsApp";
    case "VOICE":
      return "Voice call";
    case "SMS":
      return "SMS";
    case "WEB_CHAT":
      return "Web chat";
    case "IN_PERSON":
      return "In-person";
    default:
      return channel;
  }
}

/** Whole years between a date of birth and now (null when unknown). */
export function ageFrom(dob: Date | null): number | null {
  if (!dob || Number.isNaN(dob.getTime())) return null;
  const years = Math.floor((Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  return years >= 0 && years < 150 ? years : null;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function oneLine(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return truncate(text.replace(/\s+/g, " ").trim(), max);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

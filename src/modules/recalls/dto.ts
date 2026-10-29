import type { ChannelType, RecallActivityKind, RecallKind, RecallRuleKind, RecallStatus } from "@prisma/client";
import type { RECALL_CHANNELS, RECALL_OWNER_ROLES, RecallBand } from "./constants";

/**
 * Wire shapes of the recall API, shared by the route handlers, the server
 * pages and the client components. Dates are ISO strings.
 */

export type RecallOwnerRole = (typeof RECALL_OWNER_ROLES)[number];
export type RecallChannel = (typeof RECALL_CHANNELS)[number];

export interface RecallRuleDTO {
  id: string;
  name: string;
  kind: RecallRuleKind;
  treatment: { id: string; name: string } | null;
  diagnosisTerms: string[];
  dueDays: number[];
  windowDays: number;
  sessions: number | null;
  ownerRole: RecallOwnerRole;
  owner: { id: string; name: string } | null;
  channel: RecallChannel;
  active: boolean;
  /** Recalls it made that are still being worked. */
  openRecalls: number;
}

export interface RecallActivityDTO {
  id: string;
  kind: RecallActivityKind;
  outcome: string | null;
  /** The outcome in words ("No answer", "Booked", "Sent"). */
  outcomeLabel: string | null;
  note: string | null;
  messageId: string | null;
  at: string;
  /** Null: the system did it (an automatic message, a booking or visit it noticed). */
  by: { id: string; name: string } | null;
}

export interface RecallDTO {
  id: string;
  kind: RecallKind;
  kindLabel: string;
  label: string;
  status: RecallStatus;
  statusLabel: string;
  band: RecallBand;
  bandLabel: string;
  bandDays: number;
  dueAt: string;
  windowEndAt: string;
  value: number;
  channel: ChannelType;
  ownerRole: string;
  owner: { id: string; name: string } | null;
  attempts: number;
  lastContactAt: string | null;
  nextContactAt: string | null;
  snoozedUntil: string | null;
  declineReason: string | null;
  declineLabel: string | null;
  outcomeNote: string | null;
  closedAt: string | null;
  booked: { appointmentId: string; startsAt: string; doctorName: string | null } | null;
  patient: { id: string; fullName: string; phone: string | null; whatsapp: string | null; language: string; reminderConsent: boolean; marketingConsent: boolean };
  treatment: { id: string; name: string } | null;
  procedureId: string | null;
  stage: number | null;
  lastActivity: RecallActivityDTO | null;
  /** Why the worklist shows it the way it does ("Came in on 3 Nov, session 4 not marked done"). */
  hint: string | null;
  /** A WhatsApp number (or phone) to message. */
  canMessage: boolean;
  /** Enough tries without an answer that "unreachable" is offered. */
  suggestUnreachable: boolean;
  createdAt: string;
}

export interface RecallDetailDTO extends RecallDTO {
  activities: RecallActivityDTO[];
}

export type RecallTab = "today" | "soon" | "booked" | "all";

export interface RecallListDTO {
  recalls: RecallDTO[];
  total: number;
  page: number;
  pageSize: number;
  counts: { today: number; soon: number; booked: number };
}

/** A recall shown with a visit (the next-appointment card): the one the visit is booked for, or one due by then. */
export interface VisitRecallDTO {
  id: string;
  label: string;
  kindLabel: string;
  dueAt: string;
  band: RecallBand;
  bandLabel: string;
  /** The visit is the one booked for it. */
  thisVisit: boolean;
}

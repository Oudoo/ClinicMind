import type { ChannelKey, ObjectionTagKey, LeadStageKey } from "@/modules/crm/shared";

/**
 * JSON-safe shapes of the reception inbox as the API returns them and as the
 * inbox page hands them to client components. Free of server imports.
 */

export const CONVERSATION_STATUSES = ["OPEN", "WAITING_ON_CLINIC", "WAITING_ON_PATIENT", "CLOSED"] as const;
export type ConversationStatusKey = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_STATUS_LABELS: Record<ConversationStatusKey, string> = {
  OPEN: "Open",
  WAITING_ON_CLINIC: "Waiting on clinic",
  WAITING_ON_PATIENT: "Waiting on patient",
  CLOSED: "Closed",
};

export const INBOX_FILTERS = ["open", "waiting_clinic", "waiting_patient", "closed", "all"] as const;
export type InboxFilterKey = (typeof INBOX_FILTERS)[number];

export const INBOX_FILTER_LABELS: Record<InboxFilterKey, string> = {
  open: "Open",
  waiting_clinic: "Waiting on clinic",
  waiting_patient: "Waiting on patient",
  closed: "Closed",
  all: "All",
};

export const MESSAGE_AUTHORS = ["PATIENT", "AI", "HUMAN", "SYSTEM"] as const;
export type MessageAuthorKey = (typeof MESSAGE_AUTHORS)[number];

export const DELIVERY_STATES = ["QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "LOGGED"] as const;
export type DeliveryKey = (typeof DELIVERY_STATES)[number];

export const DELIVERY_LABELS: Record<DeliveryKey, string> = {
  QUEUED: "Queued",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  LOGGED: "Logged (no channel connected)",
};

export interface PersonRefDTO {
  id: string;
  fullName: string;
}

export interface MessageDTO {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  author: MessageAuthorKey;
  authorName: string | null;
  delivery: DeliveryKey;
  externalId: string | null;
  templateKey: string | null;
  failedReason: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface ConversationRowDTO {
  id: string;
  channel: ChannelKey;
  status: ConversationStatusKey;
  locale: string;
  displayName: string;
  contactName: string | null;
  contactPhone: string | null;
  patient: PersonRefDTO | null;
  lead: (PersonRefDTO & { stage: LeadStageKey }) | null;
  assignedTo: PersonRefDTO | null;
  lastMessage: { body: string; direction: "INBOUND" | "OUTBOUND"; author: MessageAuthorKey; createdAt: string } | null;
  unread: number;
  objections: ObjectionTagKey[];
  objectionsConfirmedAt: string | null;
  summary: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface InboxCountsDTO {
  open: number;
  waitingClinic: number;
  waitingPatient: number;
  closed: number;
  unread: number;
}

export interface TemplateVarsDTO {
  name: string;
  clinic: string;
  doctor: string;
  date: string;
  link: string;
}

export interface ConversationThreadDTO extends ConversationRowDTO {
  messages: MessageDTO[];
  templateContext: TemplateVarsDTO;
}

export interface TemplateDTO {
  id: string;
  key: string;
  name: string;
  language: string;
  body: string;
  channel: ChannelKey | null;
  category: string | null;
  active: boolean;
}

export interface IntegrationStatusDTO {
  provider: "manual" | "whatsapp_cloud" | "inbox_webhook";
  enabled: boolean;
  phoneNumberId: string | null;
  outboundUrl: string | null;
  secretPrefix: string | null;
  hasSecret: boolean;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  inboundUrl: string;
  env: { whatsappTokenSet: boolean; whatsappAppSecretSet: boolean; whatsappVerifyTokenSet: boolean };
}

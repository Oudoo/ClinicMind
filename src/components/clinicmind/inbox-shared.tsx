import { Badge } from "@/components/ui/primitives";
import {
  CONVERSATION_STATUS_LABELS,
  DELIVERY_LABELS,
  type ConversationStatusKey,
  type DeliveryKey,
  type InboxFilterKey,
  type MessageAuthorKey,
} from "@/modules/messaging/dto";
import type { ChannelKey } from "@/modules/crm/shared";

/**
 * Pieces shared by the inbox page (server) and its client panes: the URL of
 * a filtered list or a selected thread, status badges and message labels.
 */
export interface InboxState {
  status?: InboxFilterKey;
  channel?: ChannelKey;
  mine?: "1";
  q?: string;
  page?: number;
  /** The selected thread. */
  c?: string;
}

/** `/dashboard/conversations?status=…&c=<id>`; defaults (open, page 1) stay out of the URL. */
export function inboxHref(state: InboxState): string {
  const params = new URLSearchParams();
  if (state.status && state.status !== "open") params.set("status", state.status);
  if (state.channel) params.set("channel", state.channel);
  if (state.mine === "1") params.set("mine", "1");
  if (state.q) params.set("q", state.q);
  if (state.page && state.page > 1) params.set("page", String(state.page));
  if (state.c) params.set("c", state.c);
  const qs = params.toString();
  return `/dashboard/conversations${qs ? `?${qs}` : ""}`;
}

const STATUS_TONE: Record<ConversationStatusKey, "default" | "accent" | "success" | "warning" | "danger"> = {
  OPEN: "accent",
  WAITING_ON_CLINIC: "warning",
  WAITING_ON_PATIENT: "default",
  CLOSED: "default",
};

export function ConversationStatusBadge({ status }: { status: ConversationStatusKey }) {
  return <Badge tone={STATUS_TONE[status]}>{CONVERSATION_STATUS_LABELS[status]}</Badge>;
}

/** Who wrote a message, as the thread shows it. */
export function authorLabel(author: MessageAuthorKey, authorName: string | null): string {
  switch (author) {
    case "PATIENT":
      return "Patient";
    case "AI":
      return "AI receptionist";
    case "SYSTEM":
      return "System";
    default:
      return authorName ?? "Staff";
  }
}

/** Short delivery words under an outbound bubble. */
export const DELIVERY_SHORT: Record<DeliveryKey, string> = {
  QUEUED: "Queued",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Not delivered",
  LOGGED: "Logged",
};

export function deliveryTitle(delivery: DeliveryKey, failedReason: string | null): string {
  return delivery === "FAILED" && failedReason ? `${DELIVERY_LABELS.FAILED}: ${failedReason}` : DELIVERY_LABELS[delivery];
}

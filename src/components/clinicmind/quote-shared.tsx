import { Ban, CalendarX, Check, FileText, Hourglass, ThumbsDown, type LucideIcon } from "lucide-react";
import { QUOTE_STATE_LABELS, type QuoteState } from "@/modules/quotes/constants";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";
import { Badge } from "@/components/ui/primitives";

/** How a quote's state reads in the clinic's lists: its word, a mark of its own and a tone. No server imports. */
export const QUOTE_STATE_TONE: Record<QuoteState, BadgeTone> = {
  DRAFT: "default",
  SENT: "warning",
  EXPIRED: "danger",
  ACCEPTED: "success",
  DECLINED: "danger",
  WITHDRAWN: "default",
};

const QUOTE_STATE_ICON: Record<QuoteState, LucideIcon> = {
  DRAFT: FileText,
  SENT: Hourglass,
  EXPIRED: CalendarX,
  ACCEPTED: Check,
  DECLINED: ThumbsDown,
  WITHDRAWN: Ban,
};

export function QuoteStateBadge({ state, className }: { state: QuoteState; className?: string }) {
  const Icon = QUOTE_STATE_ICON[state];
  return (
    <Badge tone={QUOTE_STATE_TONE[state]} className={className}>
      <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
      {QUOTE_STATE_LABELS[state]}
    </Badge>
  );
}

import { QUOTE_STATE_LABELS, type QuoteState } from "@/modules/quotes/constants";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";
import { Badge } from "@/components/ui/primitives";

/** How a quote's state reads in the clinic's lists. No server imports. */
export const QUOTE_STATE_TONE: Record<QuoteState, BadgeTone> = {
  DRAFT: "default",
  SENT: "warning",
  EXPIRED: "danger",
  ACCEPTED: "success",
  DECLINED: "default",
  WITHDRAWN: "default",
};

export function QuoteStateBadge({ state }: { state: QuoteState }) {
  return <Badge tone={QUOTE_STATE_TONE[state]}>{QUOTE_STATE_LABELS[state]}</Badge>;
}

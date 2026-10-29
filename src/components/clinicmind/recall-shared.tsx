import { Badge } from "@/components/ui/primitives";
import { ApiError } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import { BAND_TONE, type RecallBand } from "@/modules/recalls/constants";
import type { RecallDTO } from "@/modules/recalls/dto";

const RECALL_ERRORS: Record<string, string> = {
  closed: "This recall is closed: reopen it first.",
  booked: "A visit is booked for this recall.",
  already_booked: "A visit is already booked for this recall.",
  state_changed: "This recall changed a moment ago. The list is refreshed.",
  no_phone: "The patient has no WhatsApp number or phone on record.",
  conflict: "That slot is already taken. Pick another one.",
  patient_conflict: "The patient already has an appointment at that time.",
  done: "A done recall stays done.",
  not_closed: "This recall is already open.",
};

/** A sentence for a failed recall call (field errors are shown by the forms). */
export function recallErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const message = (err.body as { message?: unknown } | null)?.message;
    if (typeof message === "string" && message) return message;
    const known = RECALL_ERRORS[err.code];
    if (known) return known;
    if (err.status === 403) return "Your role cannot do that.";
    if (err.status === 404) return "It no longer exists, or belongs to another clinic.";
    return err.message;
  }
  return "Could not reach the server. Please try again.";
}

export function BandBadge({ recall }: { recall: Pick<RecallDTO, "band" | "bandLabel" | "booked" | "status" | "statusLabel"> }) {
  const label = recall.band === "closed" ? recall.statusLabel : recall.bandLabel;
  const tone = recall.band === "closed" ? (recall.status === "DONE" ? "success" : "default") : BAND_TONE[recall.band as RecallBand];
  return <Badge tone={tone}>{label}</Badge>;
}

export function egp(value: number): string {
  return `${formatNumber(value)} EGP`;
}

/** The recall's patient-facing phone: WhatsApp first. */
export function phoneOf(r: Pick<RecallDTO, "patient">): string | null {
  return r.patient.whatsapp ?? r.patient.phone ?? null;
}

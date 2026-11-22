import { Signature } from "lucide-react";
import { cn, formatDate, formatTime } from "@/lib/utils";

/**
 * The clinic's signature on a record: "Signed · LH · 21 Nov 14:02" in prescription ink with a
 * fine ink rule under it. Nothing reaches a patient's record until a clinician signs it, so this
 * mark is the one detail that only ClinicMind draws, used wherever a visit, a procedure or a day
 * close has been signed, and nowhere else.
 */
export function SignedMark({ by, at, className }: { by?: string | null; at?: string | Date | null; className?: string }) {
  const initials = by
    ? by
        .replace(/^Dr\.?\s+/i, "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0]!.toUpperCase())
        .join("")
    : null;
  const when = at ? `${formatDate(at)} ${formatTime(at)}` : null;
  const label = ["Signed", by ? `by ${by}` : null, when ? `on ${when}` : null].filter(Boolean).join(" ");
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap border-b border-accent/40 pb-px text-xs font-medium text-accent", className)}
      title={label}
    >
      <Signature className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">
        Signed
        {initials ? <span className="font-mono"> · {initials}</span> : null}
        {when ? <span className="font-mono tabular-nums"> · {when}</span> : null}
      </span>
    </span>
  );
}

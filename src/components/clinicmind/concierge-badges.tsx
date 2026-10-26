import { AlertTriangle, Camera, ClipboardCheck, MessageSquareText } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import type { EnrolmentStatus, TaskStatus } from "@/modules/concierge/dto";
import { ENROLMENT_STATUS_TEXT, ENROLMENT_STATUS_TONE, KIND_TEXT, taskStatusText, taskStatusTone, TRIAGE_TEXT, TRIAGE_TONE } from "@/modules/concierge/labels";
import type { StepKind } from "@/modules/concierge/protocols";
import type { TriageFlag, TriageLevel } from "@/modules/concierge/triage";

/**
 * Concierge badges: triage, task and enrolment status, step kind, and the
 * flags a check-in raised. Plain markup, usable from server and client
 * components alike.
 */
export function TriageBadge({ level }: { level: TriageLevel }) {
  return (
    <Badge tone={TRIAGE_TONE[level]}>
      {level === "HIGH_RISK" ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : null}
      {TRIAGE_TEXT[level]}
    </Badge>
  );
}

export function TaskStatusBadge({ status, kind }: { status: TaskStatus; kind?: StepKind }) {
  return <Badge tone={taskStatusTone(status, kind)}>{taskStatusText(status, kind)}</Badge>;
}

export function EnrolmentStatusBadge({ status }: { status: EnrolmentStatus }) {
  return <Badge tone={ENROLMENT_STATUS_TONE[status]}>{ENROLMENT_STATUS_TEXT[status]}</Badge>;
}

const KIND_ICON: Record<StepKind, typeof Camera> = { INSTRUCTION: MessageSquareText, CHECK_IN: ClipboardCheck, PHOTO_REQUEST: Camera };

export function StepKindIcon({ kind, className }: { kind: StepKind; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon className={className ?? "h-4 w-4"} aria-label={KIND_TEXT[kind]} />;
}

/** "pain 9 (expected ≤ 4)", "bleeding yes (expected no)", "free text: bleeding". */
export function flagText(f: TriageFlag): string {
  if (f.key === "freeText") return f.label.replace(/^Free text mentions /, "Free text: ");
  const value = typeof f.value === "boolean" ? (f.value ? "yes" : "no") : String(f.value);
  return `${f.label}: ${value}${f.expected ? ` (expected ${f.expected})` : ""}`;
}

export function FlagList({ flags, className }: { flags: TriageFlag[]; className?: string }) {
  if (!flags.length) return null;
  return (
    <ul className={className ?? "flex flex-wrap gap-1"}>
      {flags.map((f, i) => (
        <li key={`${f.key}-${i}`}>
          <Badge tone={f.highRisk ? "danger" : "warning"} className="max-w-full whitespace-normal break-words normal-case tracking-normal">
            {flagText(f)}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

import type { TimelineKind } from "@prisma/client";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { formatDate, formatTime } from "@/lib/utils";
import type { BadgeTone } from "@/components/clinicmind/patient-shared";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title: string;
  body: string | null;
  occurredAt: Date;
}

const KIND_TONE: Record<TimelineKind, BadgeTone> = {
  APPOINTMENT: "accent",
  CALL: "default",
  WHATSAPP_MESSAGE: "default",
  DIAGNOSIS: "warning",
  PRESCRIPTION: "accent",
  AUDIO: "default",
  DOCUMENT: "default",
  AI_NOTE: "default",
  VISIT: "success",
  PROCEDURE: "success",
  PAYMENT: "accent",
  CHECK_IN: "default",
  ESCALATION: "danger",
  INTAKE: "default",
  LEAD: "default",
  LAB: "accent",
};

const KIND_LABEL: Record<TimelineKind, string> = {
  APPOINTMENT: "Appointment",
  CALL: "Call",
  WHATSAPP_MESSAGE: "WhatsApp",
  DIAGNOSIS: "Diagnosis",
  PRESCRIPTION: "Prescription",
  AUDIO: "Audio",
  DOCUMENT: "Document",
  AI_NOTE: "AI note",
  VISIT: "Visit",
  PROCEDURE: "Procedure",
  PAYMENT: "Payment",
  CHECK_IN: "Check-in",
  ESCALATION: "Escalation",
  INTAKE: "Onboarding",
  LEAD: "Lead",
  LAB: "Lab work",
};

/** Chronological feed of a patient's `TimelineEvent`s, newest first. Server component. */
export function PatientTimeline({ events }: { events: TimelineItem[] }) {
  if (!events.length) {
    return (
      <EmptyState
        title="No events yet"
        hint="Appointments, visits, diagnoses and messages appear here as they happen."
      />
    );
  }
  return (
    <ol className="relative space-y-6 border-l border-border pl-6">
      {events.map((event) => (
        <li key={event.id} className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[29px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-accent"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[event.kind]}>{KIND_LABEL[event.kind]}</Badge>
            <time
              dateTime={event.occurredAt.toISOString()}
              className="font-mono text-xs tabular-nums text-muted-foreground"
            >
              {formatDate(event.occurredAt)} · {formatTime(event.occurredAt)}
            </time>
          </div>
          <p className="mt-1 text-sm font-medium">{event.title}</p>
          {event.body ? (
            <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{event.body}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

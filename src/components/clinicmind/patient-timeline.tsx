import type { TimelineKind } from "@prisma/client";
import { EmptyState } from "@/components/ui/primitives";
import { formatDate, formatTime } from "@/lib/utils";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  title: string;
  body: string | null;
  occurredAt: Date;
}

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
  INSURANCE: "Insurance",
};

/**
 * Everything that happened to the patient, newest first, as rows: when, what kind of event,
 * and what it says. Server component; the page wraps it in a padding-less Card.
 */
export function PatientTimeline({ events }: { events: TimelineItem[] }) {
  if (!events.length) {
    return <EmptyState inCard title="Nothing on the timeline yet" hint="Appointments, visits, diagnoses and messages appear here as they happen." />;
  }
  return (
    <ol className="divide-y divide-border">
      {events.map((event) => (
        <li key={event.id} className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <div className="flex items-baseline gap-x-2 sm:flex-col sm:gap-y-0.5">
            <time dateTime={event.occurredAt.toISOString()} className="text-sm tabular-nums">
              {formatDate(event.occurredAt)} · {formatTime(event.occurredAt)}
            </time>
            <span className="data-label">{KIND_LABEL[event.kind]}</span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{event.title}</p>
            {event.body ? <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-muted-foreground">{event.body}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

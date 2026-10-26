import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, BellRing, Camera, MessageSquareText, Phone, Star } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { formatDateInTz, formatDateTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import { getEnrolmentDetail } from "@/modules/concierge/service";
import type { EscalationDTO, TaskDTO } from "@/modules/concierge/dto";
import { answerText, expectedText, formatMinutes, stepTitle } from "@/modules/concierge/labels";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { EnrolmentStatusBadge, FlagList, StepKindIcon, TaskStatusBadge, TriageBadge } from "@/components/clinicmind/concierge-badges";
import { EnrolmentActions } from "@/components/clinicmind/concierge-enrolment-actions";
import { TaskActions } from "@/components/clinicmind/concierge-task-actions";
import { EscalationActions } from "@/components/clinicmind/escalation-actions";
import { Countdown } from "@/components/clinicmind/concierge-countdown";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Concierge enrolment" };

/**
 * `/dashboard/concierge/enrolments/[id]` — one patient's follow-up: the
 * procedure and protocol version, every step on a timeline with its status,
 * the answers (with the expected ranges and the flags they raised), photo
 * thumbnails, escalations, and the controls: Pause / Resume / Stop, Send now,
 * Skip, Record answer by phone.
 */
export default async function EnrolmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "concierge:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Concierge" />
        <Card>
          <EmptyState title="The concierge is not available for your role" />
        </Card>
      </div>
    );
  }
  const canWrite = can(ctx.role, "concierge:write");
  const [enrolment, timezone] = await Promise.all([getEnrolmentDetail(ctx.tenantId, id, new Date(), { messages: canWrite }), getTenantTimezone(ctx.tenantId)]);
  if (!enrolment) notFound();

  const canSeePatient = can(ctx.role, "patients:read");
  const nowIso = new Date().toISOString();
  const at = (iso: string | null) => (iso ? formatDateTimeInTz(new Date(iso), timezone) : "—");
  const p = enrolment.progress;
  const open = enrolment.escalations.filter((e) => e.status !== "RESOLVED");
  const closed = enrolment.escalations.filter((e) => e.status === "RESOLVED");
  const running = enrolment.status === "ACTIVE" || enrolment.status === "PAUSED";

  return (
    <div className="space-y-6">
      <Link href="/dashboard/concierge?tab=enrolments" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Enrolments
      </Link>

      <SectionTitle
        title={enrolment.patient.fullName}
        description={`${enrolment.treatment.name} · ${running ? `day ${Math.min(p.day, enrolment.protocol.lengthDays)} of ${enrolment.protocol.lengthDays}` : `${p.done} of ${p.total} steps done`}`}
        action={<EnrolmentStatusBadge status={enrolment.status} />}
      />

      {enrolment.status === "PAUSED" ? (
        <Card className="border-warning/40 bg-warning/5 p-4 text-sm">
          Paused {at(enrolment.pausedAt)}
          {enrolment.pauseReason ? `: ${enrolment.pauseReason}` : ""}. Nothing new goes out until it is resumed; links already sent still work.
        </Card>
      ) : null}
      {enrolment.status === "STOPPED" ? (
        <Card className="bg-muted p-4 text-sm">
          Stopped {at(enrolment.stoppedAt)}
          {enrolment.stopReason ? `: ${enrolment.stopReason}` : ""}.
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="space-y-1 p-4 sm:p-5">
          <p className="data-label">Patient</p>
          {canSeePatient ? (
            <Link href={`/dashboard/patients/${enrolment.patient.id}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
              {enrolment.patient.fullName}
            </Link>
          ) : (
            <p className="font-medium">{enrolment.patient.fullName}</p>
          )}
          {enrolment.patient.phone ? (
            <p className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              <a href={`tel:${enrolment.patient.phone}`} className="hover:text-foreground">
                {enrolment.patient.phone}
              </a>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">Messages in {enrolment.language === "ar" ? "Arabic" : "English"} on WhatsApp</p>
        </Card>
        <Card className="space-y-1 p-4 sm:p-5">
          <p className="data-label">Procedure</p>
          <p className="font-medium">{enrolment.treatment.name}</p>
          <p className="text-xs text-muted-foreground">
            {at(enrolment.procedure.performedAt)}
            {enrolment.procedure.doctorName ? ` · ${enrolment.procedure.doctorName}` : ""}
          </p>
        </Card>
        <Card className="space-y-1 p-4 sm:p-5">
          <p className="data-label">Protocol</p>
          <p className="font-medium">
            {enrolment.protocol.name} <span className="font-mono text-xs text-muted-foreground">v{enrolment.protocol.version}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {p.total} steps over {enrolment.protocol.lengthDays} days · started {formatDateInTz(new Date(enrolment.startedAt), timezone)}
          </p>
        </Card>
        <Card className="space-y-2 p-4 sm:p-5">
          <p className="data-label">Progress</p>
          <div className="h-2 overflow-hidden rounded bg-muted" aria-hidden="true">
            <div className="h-full rounded bg-accent" style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {p.done} of {p.total} done{p.awaiting ? ` · ${p.awaiting} awaiting an answer` : ""}
            {p.nextTitle && p.nextDueAt ? ` · next: ${p.nextTitle}, ${at(p.nextDueAt)}` : ""}
          </p>
          {canWrite ? <EnrolmentActions enrolmentId={enrolment.id} status={enrolment.status} patientName={enrolment.patient.fullName} /> : null}
        </Card>
      </div>

      {open.length ? (
        <section aria-labelledby="open-escalations" className="space-y-3">
          <h3 id="open-escalations" className="font-display text-base font-semibold tracking-tight">
            Open escalations
          </h3>
          <ul className="space-y-3">
            {open.map((e) => (
              <EscalationItem key={e.id} e={e} at={at} nowIso={nowIso} canWrite={canWrite} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="timeline" className="space-y-3">
        <h3 id="timeline" className="font-display text-base font-semibold tracking-tight">
          Steps
        </h3>
        <ol className="relative space-y-3 border-l border-border pl-4 sm:pl-6">
          {enrolment.tasks.map((t) => (
            <TaskItem
              key={t.id}
              t={t}
              at={at}
              canWrite={canWrite}
              dueSoon={Date.parse(t.dueAt) - Date.parse(nowIso) < 2 * 86_400_000}
              enrolment={{ status: enrolment.status, patientName: enrolment.patient.fullName }}
            />
          ))}
        </ol>
      </section>

      {closed.length ? (
        <section aria-labelledby="closed-escalations" className="space-y-3">
          <h3 id="closed-escalations" className="font-display text-base font-semibold tracking-tight">
            Resolved escalations
          </h3>
          <ul className="space-y-3">
            {closed.map((e) => (
              <EscalationItem key={e.id} e={e} at={at} nowIso={nowIso} canWrite={false} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function EscalationItem({ e, at, nowIso, canWrite }: { e: EscalationDTO; at: (iso: string | null) => string; nowIso: string; canWrite: boolean }) {
  const overdue = e.status === "OPEN" && Date.parse(e.dueAt) < Date.parse(nowIso);
  return (
    <li className={cn("bento-tight space-y-2", overdue && "border-danger/50 bg-danger/5")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <TriageBadge level={e.level} />
            <Badge tone={e.status === "RESOLVED" ? "success" : e.status === "ACKNOWLEDGED" ? "accent" : "warning"}>{e.status.toLowerCase()}</Badge>
            <span className="text-xs text-muted-foreground">
              {e.assignedToName ?? "Unassigned"} · {e.outOfHours ? "out of hours" : "in hours"} · target {e.targetMinutes ?? "—"} min
            </span>
          </div>
          <p className="break-words text-sm">{e.summary}</p>
          <FlagList flags={e.flags} />
        </div>
        {e.status === "OPEN" ? <Countdown dueAt={e.dueAt} serverNow={nowIso} className="text-sm" /> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
        <p className="min-w-0">
          Opened {at(e.createdAt)}
          {e.acknowledgedAt ? (
            <>
              {" "}
              · acknowledged {at(e.acknowledgedAt)}
              {e.acknowledgedByName ? ` by ${e.acknowledgedByName}` : ""}{" "}
              <span className={e.acknowledgedWithinTarget ? "text-success" : "text-danger"}>
                ({e.acknowledgedWithinTarget ? "within target" : `${formatMinutes((Date.parse(e.acknowledgedAt) - Date.parse(e.dueAt)) / 60_000)} late`})
              </span>
            </>
          ) : null}
          {e.resolvedAt ? ` · resolved ${at(e.resolvedAt)}${e.resolvedByName ? ` by ${e.resolvedByName}` : ""}` : ""}
          {e.resolution ? <span className="mt-1 block text-foreground">“{e.resolution}”</span> : null}
        </p>
        {canWrite ? <EscalationActions escalation={e} /> : null}
      </div>
    </li>
  );
}

function TaskItem({
  t,
  at,
  canWrite,
  dueSoon,
  enrolment,
}: {
  t: TaskDTO;
  at: (iso: string | null) => string;
  canWrite: boolean;
  dueSoon: boolean;
  enrolment: { status: "ACTIVE" | "PAUSED" | "COMPLETED" | "STOPPED"; patientName: string };
}) {
  const c = t.checkIn;
  const flagged = new Set((c?.flags ?? []).map((f) => f.key));
  return (
    <li className="relative">
      <span
        className={cn(
          "absolute -left-[1.4rem] top-4 h-2.5 w-2.5 rounded-full border-2 border-card sm:-left-[1.9rem]",
          t.status === "ANSWERED" ? "bg-success" : t.status === "MISSED" ? "bg-danger" : t.status === "SENT" ? "bg-accent" : "bg-muted-foreground/40",
        )}
        aria-hidden="true"
      />
      <div className={cn("bento-tight space-y-3", c?.triage === "HIGH_RISK" && "border-danger/40")}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <StepKindIcon kind={t.kind} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="font-medium">{stepTitle(t.dayLabel, t.title)}</p>
              <p className="text-xs text-muted-foreground">
                {t.status === "PENDING" ? `goes out ${at(t.dueAt)}` : t.sentAt ? `sent ${at(t.sentAt)}` : `was due ${at(t.dueAt)}`}
                {t.answeredAt ? ` · answered ${at(t.answeredAt)}` : ""}
                {t.missedAt && t.status === "MISSED" ? ` · missed ${at(t.missedAt)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {t.hasHighRisk ? <Badge tone="warning">red-flag questions</Badge> : null}
            {t.attempts >= 2 && (t.status === "SENT" || t.status === "MISSED" || t.status === "ANSWERED") && t.kind !== "INSTRUCTION" ? (
              <Badge>
                <BellRing className="h-3 w-3" aria-hidden="true" />
                reminded
              </Badge>
            ) : null}
            {c ? <TriageBadge level={c.triage} /> : null}
            <TaskStatusBadge status={t.status} kind={t.kind} />
          </div>
        </div>

        {t.lastError ? <p className="rounded-md bg-danger/5 px-2 py-1 text-xs text-danger">{t.lastError}</p> : null}

        {c ? (
          <div className="space-y-3 rounded-md bg-muted/50 p-3">
            {t.questions.length ? (
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {t.questions.map((q) => {
                  const value = c.answers[q.key];
                  const expected = expectedText(q);
                  const hit = flagged.has(q.key);
                  return (
                    <div key={q.key} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">{q.label.en}</dt>
                      <dd className={cn("text-sm", hit && "font-semibold text-danger")}>
                        {answerText(q.type, value, q.max ?? 10)}
                        {expected && value !== undefined ? <span className="ml-1 text-xs font-normal text-muted-foreground">(expected {expected})</span> : null}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : null}
            {c.satisfaction ? (
              <p className="flex items-center gap-1 text-sm" aria-label={`Satisfaction ${c.satisfaction} of 5`}>
                {Array.from({ length: 5 }, (_, i) => (
                  <Star key={i} className={cn("h-4 w-4", i < c.satisfaction! ? "fill-current text-warning" : "text-muted-foreground/40")} aria-hidden="true" />
                ))}
                <span className="ml-1 text-xs text-muted-foreground">{c.satisfaction}/5</span>
              </p>
            ) : null}
            {c.freeText ? (
              <p className="flex items-start gap-1.5 text-sm">
                <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 break-words">“{c.freeText}”</span>
              </p>
            ) : null}
            {c.photoIds.length ? (
              <ul className="flex flex-wrap gap-2" aria-label="Photos">
                {c.photoIds.map((photoId, i) => (
                  <li key={photoId}>
                    <a href={`/api/concierge/files/${photoId}`} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-md border border-border hover:border-accent">
                      <img src={`/api/concierge/files/${photoId}`} alt={`${t.dayLabel} photo ${i + 1}${t.photos[i] ? ` (${t.photos[i]})` : ""}`} className="h-24 w-24 object-cover sm:h-28 sm:w-28" loading="lazy" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : t.kind === "PHOTO_REQUEST" ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Camera className="h-3.5 w-3.5" aria-hidden="true" />
                No photo stored
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{c.source === "staff" ? "Recorded by phone" : "Answered through the link"} · {at(c.submittedAt)}</span>
              <FlagList flags={c.flags} />
            </div>
          </div>
        ) : null}

        {t.message ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Message sent {at(t.message.sentAt)} · {t.message.delivery === "LOGGED" ? "logged on the conversation (no WhatsApp channel connected)" : t.message.delivery.toLowerCase()}
            </summary>
            <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-sm" dir="auto">
              <Linkified text={t.message.body} />
            </p>
          </details>
        ) : t.body && !c ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Message</summary>
            <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
              <p dir="rtl" lang="ar" className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm">
                {t.body.ar}
              </p>
              <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm">{t.body.en}</p>
            </div>
          </details>
        ) : null}

        {canWrite ? <TaskActions task={t} enrolmentStatus={enrolment.status} patientName={enrolment.patientName} dueSoon={dueSoon} /> : null}
      </div>
    </li>
  );
}

/** The message text with its check-in link clickable (opens the patient's page in a new tab). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="break-all text-accent underline" dir="ltr">
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

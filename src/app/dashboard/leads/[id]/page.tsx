import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowLeft, CalendarCheck, Mail, MessageCircle, Phone, UserRound } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { initials } from "@/lib/utils";
import { dateKeyInTz, formatDateInTz, formatTimeInTz } from "@/lib/time";
import { getTenantTimezone, listStaff } from "@/modules/appointments/service";
import { listTreatments } from "@/modules/treatments/service";
import { getLead, listCampaignRefs, listTenantStaff } from "@/modules/crm/service";
import { CHANNEL_LABELS, LOST_REASON_LABELS, SOURCE_LABELS, STAGE_LABELS, ageLabel, waMeLink } from "@/modules/crm/shared";
import { CONVERSATION_STATUS_LABELS } from "@/modules/messaging/dto";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { LeadHeaderActions, LeadStageStepper } from "@/components/clinicmind/lead-actions";
import { AddFollowUpForm, CompleteFollowUpButton } from "@/components/clinicmind/lead-follow-ups";
import { ChannelBadge, LostReasonBadge, ObjectionBadges, OwnerChip, SourceBadge, StageBadge, overdueLabel, whenLabel } from "@/components/clinicmind/lead-shared";

export const dynamic = "force-dynamic";

const APPOINTMENT_STATUS: Record<string, { label: string; tone: "default" | "accent" | "success" | "warning" | "danger" }> = {
  SCHEDULED: { label: "Scheduled", tone: "default" },
  CONFIRMED: { label: "Confirmed", tone: "accent" },
  CHECKED_IN: { label: "Checked in", tone: "accent" },
  IN_PROGRESS: { label: "In progress", tone: "accent" },
  COMPLETED: { label: "Attended", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
  NO_SHOW: { label: "No-show", tone: "danger" },
  WAITLISTED: { label: "Waitlisted", tone: "warning" },
};

/** `/dashboard/leads/[id]` — one lead: details, the stage stepper, follow-ups, conversations, consultation and patient. */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "leads:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Lead" />
        <Card>
          <EmptyState title="Leads are not available for your role" />
        </Card>
      </div>
    );
  }

  const lead = await getLead(ctx.tenantId, id);
  if (!lead) notFound();

  const [timezone, treatments, staff, campaigns, bookable] = await Promise.all([
    getTenantTimezone(ctx.tenantId),
    listTreatments(ctx.tenantId),
    listTenantStaff(ctx.tenantId),
    listCampaignRefs(ctx.tenantId),
    listStaff(ctx.tenantId),
  ]);
  const now = new Date();
  const canWrite = can(ctx.role, "leads:write");
  const canBook = canWrite && can(ctx.role, "appointments:write");
  const doctors = bookable.filter((s) => s.role !== "NURSE").sort((a, b) => (a.role === b.role ? a.fullName.localeCompare(b.fullName) : a.role === "DOCTOR" ? -1 : 1));
  const firstInterest = treatments.find((t) => t.key === lead.interests[0]);
  const open = lead.followUps.filter((f) => !f.doneAt);
  const done = lead.followUps.filter((f) => f.doneAt);
  const wa = waMeLink(lead.whatsapp ?? lead.phone);
  const date = (d: Date) => formatDateInTz(d, timezone);
  const lastConversationObjections = [...new Set(lead.conversations.flatMap((c) => c.objections))];

  return (
    <div className="space-y-6">
      <Link href="/dashboard/leads" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" />
        Leads
      </Link>

      <Card className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span aria-hidden="true" className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-accent-muted font-mono text-lg text-accent">
              {initials(lead.fullName)}
            </span>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-2xl font-semibold tracking-tight">{lead.fullName}</h2>
                <StageBadge stage={lead.stage} />
                {lead.stage === "LOST" ? <LostReasonBadge reason={lead.lostReason} /> : null}
              </div>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <SourceBadge source={lead.source} />
                {lead.campaign ? <span>{lead.campaign.name}</span> : null}
                <span>· came in {ageLabel(lead.createdAt, now)} ago ({date(lead.createdAt)})</span>
              </p>
              <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-xs text-muted-foreground">
                {lead.phone ? (
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">Phone</dt>
                    <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                    <dd>
                      <a href={`tel:${lead.phone}`} className="hover:text-foreground">
                        {lead.phone}
                      </a>
                    </dd>
                  </div>
                ) : null}
                {wa ? (
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">WhatsApp</dt>
                    <MessageCircle className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                    <dd>
                      <a href={wa} target="_blank" rel="noopener noreferrer" className="hover:text-foreground" title="Open a WhatsApp chat (wa.me)">
                        {lead.whatsapp ?? lead.phone} ↗
                      </a>
                    </dd>
                  </div>
                ) : null}
                {lead.email ? (
                  <div className="flex items-center gap-1.5">
                    <dt className="sr-only">E-mail</dt>
                    <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                    <dd className="truncate">{lead.email}</dd>
                  </div>
                ) : null}
                <div className="flex items-center gap-1.5">
                  <dt className="sr-only">Owner</dt>
                  <OwnerChip owner={lead.owner} />
                  <dd className="font-sans">{lead.owner?.fullName ?? "Unassigned"}</dd>
                </div>
              </dl>
            </div>
          </div>
          <LeadHeaderActions
            lead={{ id: lead.id, fullName: lead.fullName, phone: lead.phone, stage: lead.stage, source: lead.source, patientId: lead.patientId, objections: lead.objections.length ? lead.objections : lastConversationObjections }}
            form={{
              fullName: lead.fullName,
              phone: lead.phone ?? "",
              whatsapp: lead.whatsapp && lead.whatsapp !== lead.phone ? lead.whatsapp : "",
              email: lead.email ?? "",
              source: lead.source,
              campaignId: lead.campaignId ?? "",
              interests: lead.interests,
              ownerId: lead.ownerId ?? "",
              notes: lead.notes ?? "",
              stage: "NEW",
            }}
            options={{ treatments: treatments.map((t) => ({ key: t.key, name: t.name })), staff, campaigns }}
            doctors={doctors}
            timezone={timezone}
            defaultReason={`Consultation${firstInterest ? ` — ${firstInterest.name}` : ""}`}
            canWrite={canWrite}
            canBook={canBook}
          />
        </div>
        <LeadStageStepper lead={{ id: lead.id, fullName: lead.fullName, stage: lead.stage }} lostAtStage={lead.lostAtStage} canWrite={canWrite} />
        {lead.stage === "LOST" ? (
          <p className="text-sm text-danger">
            Lost at “{STAGE_LABELS[lead.lostAtStage ?? "NEW"]}” on {lead.lostAt ? date(lead.lostAt) : "—"} · {lead.lostReason ? LOST_REASON_LABELS[lead.lostReason] : "no reason"}
            {lead.lostNote ? <span className="text-muted-foreground"> — “{lead.lostNote}”</span> : null}
          </p>
        ) : null}
        {lead.stage === "WON" && lead.wonAt ? <p className="text-sm text-success">Won on {date(lead.wonAt)}.</p> : null}
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <Card className="space-y-4">
            <SectionTitle title="Details" />
            <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <Detail label="Interested in">
                {lead.interestNames.length ? (
                  <span className="flex flex-wrap gap-1">
                    {lead.interestNames.map((n) => (
                      <Badge key={n} tone="accent">
                        {n}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "Not said yet"
                )}
              </Detail>
              <Detail label="Source">{SOURCE_LABELS[lead.source]}</Detail>
              <Detail label="Campaign">{lead.campaign?.name ?? "—"}</Detail>
              <Detail label="Last contact">{lead.lastContactAt ? whenLabel(lead.lastContactAt, timezone, now) : "Not contacted yet"}</Detail>
              <Detail label="Objections">
                {lead.objections.length ? <ObjectionBadges objections={lead.objections} /> : lastConversationObjections.length ? (
                  <span className="space-y-1">
                    <ObjectionBadges objections={lastConversationObjections} />
                    <span className="block text-xs text-muted-foreground">Suggested from the conversations; confirmed when the lead closes.</span>
                  </span>
                ) : (
                  "None heard"
                )}
              </Detail>
              <Detail label="Notes">{lead.notes ? <span className="block whitespace-pre-wrap" dir="auto">{lead.notes}</span> : "—"}</Detail>
            </dl>
          </Card>

          <Card className="space-y-4">
            <SectionTitle title="Follow-ups" description="The next touch and what happened on the last ones." action={open.length ? <Badge tone="accent">{open.length} open</Badge> : null} />
            {open.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {open.map((f) => {
                  const overdue = f.dueAt < now;
                  return (
                    <li key={f.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm" dir="auto">{f.note ?? "Follow up"}</p>
                        <p className="flex flex-wrap items-center gap-x-2 font-mono text-xs text-muted-foreground">
                          <span className={overdue ? "text-danger" : undefined}>{whenLabel(f.dueAt, timezone, now)}</span>
                          {overdue ? <Badge tone="danger">{overdueLabel(f.dueAt.toISOString(), now)}</Badge> : null}
                          {f.channel ? <span>· {CHANNEL_LABELS[f.channel]}</span> : null}
                          <span>· {f.owner?.fullName ?? "Unassigned"}</span>
                        </p>
                      </div>
                      {canWrite ? <CompleteFollowUpButton followUp={{ id: f.id, leadName: lead.fullName, note: f.note }} /> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No open follow-up.</p>
            )}
            {canWrite && lead.stage !== "LOST" && lead.stage !== "WON" ? (
              <AddFollowUpForm leadId={lead.id} staff={staff} defaultOwnerId={null} timezone={timezone} />
            ) : null}
            {done.length ? (
              <details className="group">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Done ({done.length})</summary>
                <ul className="mt-2 space-y-2">
                  {done.map((f) => (
                    <li key={f.id} className="rounded-md bg-muted/50 p-3 text-sm">
                      <p dir="auto">{f.outcome ?? "Done"}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {f.doneAt ? whenLabel(f.doneAt, timezone, now) : ""} · {f.doneBy?.fullName ?? "—"}
                        {f.note ? ` · ${f.note}` : ""}
                      </p>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </Card>

          <Card className="space-y-4">
            <SectionTitle title="Conversations" description="Threads with this lead in the reception inbox." />
            {lead.conversations.length ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {lead.conversations.map((c) => {
                  const last = c.messages[0];
                  return (
                    <li key={c.id}>
                      <Link href={`/dashboard/conversations?c=${c.id}`} className="flex flex-col gap-1 p-3 hover:bg-muted/50 sm:flex-row sm:items-center sm:justify-between">
                        <span className="min-w-0 space-y-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <ChannelBadge channel={c.channel} />
                            <Badge tone={c.status === "WAITING_ON_CLINIC" ? "warning" : c.status === "CLOSED" ? "default" : "accent"}>{CONVERSATION_STATUS_LABELS[c.status]}</Badge>
                            <span className="font-mono text-xs text-muted-foreground">{c._count.messages} messages</span>
                          </span>
                          {last ? (
                            <span className="block truncate text-sm text-muted-foreground" dir="auto">
                              {last.direction === "INBOUND" ? "" : "↩ "}
                              {last.body}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{whenLabel(c.updatedAt, timezone, now)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No conversation linked yet. Threads from this number link themselves; others can be linked from the inbox.</p>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-4">
          <Card className="space-y-3">
            <SectionTitle title="Consultation" />
            {lead.consultation ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="flex items-center gap-2 font-mono text-sm tabular-nums">
                  <CalendarCheck className="h-4 w-4 text-accent" aria-hidden="true" />
                  {formatDateInTz(lead.consultation.startsAt, timezone, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })} · {formatTimeInTz(lead.consultation.startsAt, timezone)}
                </p>
                <p className="text-sm">{lead.consultation.doctor?.fullName ?? "No doctor"}{lead.consultation.room ? ` · ${lead.consultation.room}` : ""}</p>
                <div className="flex items-center justify-between gap-2">
                  <Badge tone={APPOINTMENT_STATUS[lead.consultation.status]?.tone ?? "default"}>{APPOINTMENT_STATUS[lead.consultation.status]?.label ?? lead.consultation.status}</Badge>
                  <Link href={`/dashboard/appointments?view=day&date=${dateKeyInTz(lead.consultation.startsAt, timezone)}`} className="text-xs text-accent hover:underline">
                    Open the day
                  </Link>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{canBook && lead.stage !== "LOST" ? "No consultation booked yet. Use “Book consultation” above." : "No consultation booked."}</p>
            )}
          </Card>

          <Card className="space-y-3">
            <SectionTitle title="Patient" />
            {lead.patient ? (
              <Link href={`/dashboard/patients/${lead.patient.id}`} className="flex items-center gap-3 rounded-md border border-border p-3 hover:bg-muted/50">
                <UserRound className="h-5 w-5 text-accent" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{lead.patient.fullName}</span>
                  <span className="block font-mono text-xs text-muted-foreground">{lead.patient.phone ?? "—"}</span>
                </span>
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">Not a patient yet. Converting creates the record (booking a consultation does it too).</p>
            )}
          </Card>

          {lead.escalations.length ? (
            <Card className="space-y-3">
              <SectionTitle title="Escalations" />
              <ul className="space-y-2">
                {lead.escalations.map((e) => (
                  <li key={e.id} className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block">{e.summary}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {e.status.toLowerCase()} · respond by {whenLabel(e.dueAt, timezone, now)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="data-label">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { ArrowLeft, Mail, MessageCircle, Phone, ScrollText, Users } from "lucide-react";
import type { AppointmentStatus } from "@prisma/client";
import { db, withTenant } from "@/lib/db";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { clientIp, userAgent } from "@/lib/auth/request";
import { getPatient, historyLists } from "@/modules/patients/service";
import { auditHref } from "@/modules/audit/query";
import { recordPatientView } from "@/modules/audit/views";
import { ageFrom, formatCalendarDate, formatDate, formatTime, initials } from "@/lib/utils";
import { Badge, Bento, Card, EmptyState, Metric, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PatientHeaderActions } from "@/components/clinicmind/patient-actions";
import { MedicalHistoryEditor } from "@/components/clinicmind/patient-history-editor";
import { PatientTimeline } from "@/components/clinicmind/patient-timeline";
import { PatientVisitsTable, type VisitRow } from "@/components/clinicmind/patient-visits-table";
import { PatientNextAppointment } from "@/components/clinicmind/patient-next-appointment";
import { PatientRecalls } from "@/components/clinicmind/patient-recalls";
import { PatientConciergeCard } from "@/components/clinicmind/patient-concierge-card";
import { PatientFinanceCard } from "@/components/clinicmind/patient-finance-card";
import { PatientLeadCard } from "@/components/clinicmind/patient-lead-card";
import { PatientIntakeCard } from "@/components/clinicmind/patient-intake-card";
import { PatientAccount } from "@/components/clinicmind/patient-account";
import { BalanceChip } from "@/components/clinicmind/patient-balance";
import { canSeeAccounts, patientBalances } from "@/modules/finance/ledger";
import { getHousehold } from "@/modules/finance/household";
import { getTenantTimezone } from "@/modules/appointments/service";
import { pregnancyLine } from "@/modules/patients/pregnancy";
import { weightLine } from "@/modules/patients/weight";
import {
  GENDER_LABELS,
  languageLabel,
  patientFormValues,
  type BadgeTone,
} from "@/components/clinicmind/patient-shared";

export const dynamic = "force-dynamic";

const APPOINTMENT_TONE: Record<AppointmentStatus, BadgeTone> = {
  SCHEDULED: "default",
  CONFIRMED: "accent",
  CHECKED_IN: "accent",
  IN_PROGRESS: "accent",
  COMPLETED: "success",
  CANCELLED: "danger",
  NO_SHOW: "danger",
  WAITLISTED: "warning",
};

/** One session lookup and one patient read per request, shared by the title and the page. */
const actingContext = cache(() => getActingContext());
const loadPatient = cache((tenantId: string, id: string) => getPatient(tenantId, id));

/** The browser tab shows the patient's name (audit: it showed the record id). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const ctx = await actingContext();
  const patient = ctx ? await loadPatient(ctx.tenantId, id) : null;
  return { title: patient ? patient.fullName : "Patient" };
}

export default async function PatientPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  // `?tab=account` opens a tab (from the finance reports); anything else, the overview.
  const asked = (await searchParams).tab;
  const ctx = await actingContext();
  if (!ctx) return null;

  const patient = await loadPatient(ctx.tenantId, id);
  if (!patient) notFound();

  // Opening a record is logged (who, when, from where) once the page has been sent.
  const requestHeaders = await headers();
  const view = {
    tenantId: ctx.tenantId,
    patientId: patient.id,
    actorId: ctx.userId,
    actorEmail: ctx.email,
    ip: clientIp({ headers: requestHeaders }),
    device: userAgent({ headers: requestHeaders }),
  };
  // Runs after the response, outside the render: it enters the clinic's database scope itself.
  after(() => withTenant(view.tenantId, () => recordPatientView(view)).catch((err) => console.error("[audit] could not log a record view", err)));

  const archived = patient.deletedAt !== null;
  const canWrite = can(ctx.role, "patients:write");
  const history = historyLists(patient.medicalHistory);
  const age = ageFrom(patient.dateOfBirth);
  const activeMeds = patient.medications.filter((m) => m.active);
  const stoppedMeds = patient.medications.filter((m) => !m.active);
  const lastVisit = patient.visits[0] ?? null;
  // What the patient owes and who pays for them: for the roles that take payments and the owner.
  const seesAccounts = canSeeAccounts(ctx.role);
  const [balance, household] = seesAccounts
    ? await Promise.all([patientBalances(db, ctx.tenantId, [patient.id]).then((b) => b.get(patient.id) ?? 0), getHousehold(ctx.tenantId, patient.id)])
    : [null, null];
  const timezone = await getTenantTimezone(ctx.tenantId);

  const visitRows: VisitRow[] = [
    ...patient.visits.map(
      (v): VisitRow => ({
        id: `visit-${v.id}`,
        kind: "visit",
        date: v.createdAt,
        doctor: v.doctor?.fullName ?? v.doctor?.email ?? null,
        summary: v.summary ?? v.notes,
        status: v.consultation?.status ?? null,
      }),
    ),
    ...patient.consultations
      .filter((c) => !c.visitId)
      .map(
        (c): VisitRow => ({
          id: `consultation-${c.id}`,
          kind: "consultation",
          date: c.createdAt,
          doctor: c.doctor?.fullName ?? c.doctor?.email ?? null,
          summary: c.summary,
          status: c.status,
        }),
      ),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <>
      <div className="space-y-6">
        <Link
          href="/dashboard/patients"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Patients
        </Link>

        <Card>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="flex min-w-0 items-start gap-4">
              <span
                aria-hidden="true"
                className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-accent-muted font-mono text-lg text-accent"
              >
                {initials(patient.fullName)}
              </span>
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-2xl font-semibold tracking-tight">{patient.fullName}</h1>
                  {archived ? <Badge tone="danger">archived</Badge> : null}
                  <BalanceChip balance={balance} />
                </div>
                <p className="text-sm text-muted-foreground">
                  {age !== null ? `${age} years` : "Age unknown"} · {GENDER_LABELS[patient.gender]}
                  {patient.dateOfBirth ? ` · born ${formatCalendarDate(patient.dateOfBirth)}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="patient-weight">{weightLine(patient, timezone)}</span>
                  {patient.gender !== "MALE" ? (
                    <>
                      {" · "}
                      <span data-testid="patient-pregnancy">{pregnancyLine(patient, timezone)}</span>
                    </>
                  ) : null}
                </p>
                <dl className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs text-muted-foreground">
                  <ContactItem icon={Phone} label="Phone" value={patient.phone} />
                  <ContactItem icon={MessageCircle} label="WhatsApp" value={patient.whatsapp} />
                  <ContactItem icon={Mail} label="E-mail" value={patient.email} />
                </dl>
                <div className="flex flex-wrap gap-1">
                  <Badge tone="accent">{languageLabel(patient.language)}</Badge>
                  {patient.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
                {household && household.role !== "none" ? (
                  <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Users className="h-3.5 w-3.5" aria-hidden="true" />
                    {household.role === "member" && household.head ? (
                      <>
                        Paid for by{" "}
                        <Link href={`/dashboard/patients/${household.head.id}`} className="text-accent underline-offset-2 hover:underline">
                          {household.head.fullName}
                        </Link>
                      </>
                    ) : (
                      `Pays for ${household.members.length} family member${household.members.length === 1 ? "" : "s"}`
                    )}
                  </p>
                ) : null}
                {can(ctx.role, "audit:read") ? (
                  <Link
                    href={auditHref({ patient: patient.id })}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
                    Access log: who opened or changed this record
                  </Link>
                ) : null}
              </div>
            </div>
            {canWrite ? (
              <PatientHeaderActions
                patientId={patient.id}
                fullName={patient.fullName}
                archived={archived}
                form={patientFormValues(patient, timezone)}
              />
            ) : null}
          </div>
        </Card>

        <Bento>
          <Metric
            label="Upcoming appointments"
            value={patient.upcomingAppointments.length}
            tone={patient.upcomingAppointments.length ? "accent" : "default"}
          />
          <Metric
            label="Visits"
            value={patient._count.visits}
            hint={lastVisit ? `Last on ${formatDate(lastVisit.createdAt)}` : "No visits yet"}
          />
          <Metric
            label="Active medications"
            value={activeMeds.length}
            hint={stoppedMeds.length ? `${stoppedMeds.length} stopped` : undefined}
          />
          <Metric label="Timeline events" value={patient._count.timeline} />
        </Bento>

        <Tabs defaultValue={asked === "account" && seesAccounts ? "account" : asked === "timeline" || asked === "visits" || asked === "documents" ? asked : "overview"}>
          <TabsList className="h-auto flex-wrap">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="visits">Visits &amp; consultations</TabsTrigger>
            {seesAccounts ? <TabsTrigger value="account">Account</TabsTrigger> : null}
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                <Card className="space-y-4">
                  <SectionTitle
                    title="Medical history"
                    description="Chronic conditions, allergies, diagnoses and surgeries."
                    action={
                      canWrite && !archived ? (
                        <MedicalHistoryEditor patientId={patient.id} history={history} />
                      ) : null
                    }
                  />
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <HistoryList label="Chronic conditions" items={history.chronicConditions} tone="warning" />
                    <HistoryList label="Allergies" items={history.allergies} tone="danger" />
                    <HistoryList label="Diagnoses" items={history.diagnoses} tone="accent" />
                    <HistoryList label="Surgeries" items={history.surgeries} tone="default" />
                  </div>
                </Card>

                <Card className="overflow-hidden p-0">
                  <div className="border-b border-border px-6 py-4">
                    <SectionTitle
                      title="Medications"
                      description="Prescribed when consultations are signed; read-only here."
                      action={<Badge tone="accent">{activeMeds.length} active</Badge>}
                    />
                  </div>
                  {activeMeds.length ? (
                    <Table>
                      <THead>
                        <TR className="hover:bg-transparent">
                          <TH>Medication</TH>
                          <TH>Dosage</TH>
                          <TH className="hidden sm:table-cell">Frequency</TH>
                          <TH className="hidden md:table-cell">Since</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {activeMeds.map((m) => (
                          <TR key={m.id}>
                            <TD className="font-medium">{m.name}</TD>
                            <TD className="text-muted-foreground">{m.dosage ?? "—"}</TD>
                            <TD className="hidden text-muted-foreground sm:table-cell">{m.frequency ?? "—"}</TD>
                            <TD className="hidden whitespace-nowrap font-mono text-xs text-muted-foreground md:table-cell">
                              {m.startDate ? formatDate(m.startDate) : "—"}
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  ) : (
                    <div className="p-6">
                      <EmptyState
                        title="No active medications"
                        hint="Medications are added when a consultation is signed."
                      />
                    </div>
                  )}
                  {stoppedMeds.length ? (
                    <p className="border-t border-border px-6 py-3 text-xs text-muted-foreground">
                      <span className="data-label">Stopped</span>{" "}
                      {stoppedMeds
                        .map((m) => `${m.name}${m.stoppedAt ? ` (${formatDate(m.stoppedAt)})` : ""}`)
                        .join(", ")}
                    </p>
                  ) : null}
                </Card>
              </div>

              <div className="space-y-4">
                <PatientNextAppointment tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
                <PatientRecalls tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} archived={archived} />
                <Card className="space-y-3">
                  <SectionTitle title="Upcoming appointments" />
                  {patient.upcomingAppointments.length ? (
                    <ul className="space-y-2">
                      {patient.upcomingAppointments.map((a) => {
                        const where = [
                          a.doctor?.fullName ?? a.doctor?.email,
                          a.clinic?.name,
                          a.room ? `Room ${a.room}` : null,
                        ].filter(Boolean);
                        return (
                          <li
                            key={a.id}
                            className="flex items-start justify-between gap-3 rounded-md border border-border p-3"
                          >
                            <div className="min-w-0">
                              <p className="font-mono text-xs tabular-nums">
                                {formatDate(a.startsAt)} · {formatTime(a.startsAt)}–{formatTime(a.endsAt)}
                              </p>
                              <p className="truncate text-sm font-medium">{a.reason ?? "Appointment"}</p>
                              {where.length ? (
                                <p className="truncate text-xs text-muted-foreground">{where.join(" · ")}</p>
                              ) : null}
                            </div>
                            <Badge tone={APPOINTMENT_TONE[a.status]}>{a.status.replace("_", " ")}</Badge>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <EmptyState title="Nothing scheduled" hint="Upcoming bookings appear here." />
                  )}
                </Card>

                <Card className="space-y-3">
                  <SectionTitle title="Contact &amp; emergency" />
                  <DetailRow label="Emergency contact" value={patient.emergencyContact} />
                  <DetailRow label="Address" value={patient.address} />
                  <DetailRow label="Language" value={languageLabel(patient.language)} />
                  <DetailRow
                    label="WhatsApp reminders"
                    value={patient.reminderConsent ? "Yes" : `No${patient.reminderConsentAt ? ` (since ${formatDate(patient.reminderConsentAt)})` : ""}`}
                  />
                  <DetailRow
                    label="Offers and news"
                    value={patient.marketingConsent ? `Yes${patient.marketingConsentAt ? ` (since ${formatDate(patient.marketingConsentAt)})` : ""}` : "No"}
                  />
                  <DetailRow label="Registered" value={formatDate(patient.createdAt)} />
                </Card>

                <Card className="space-y-3">
                  <SectionTitle title="Notes" />
                  {patient.notes ? (
                    <p className="whitespace-pre-wrap text-sm">{patient.notes}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">No notes on this patient.</p>
                  )}
                </Card>
                <PatientConciergeCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
                <PatientFinanceCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
                <PatientLeadCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
                <PatientIntakeCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="timeline">
            <Card>
              <PatientTimeline events={patient.timeline} />
            </Card>
          </TabsContent>

          <TabsContent value="visits">
            <Card className="overflow-hidden p-0">
              <PatientVisitsTable rows={visitRows} />
            </Card>
          </TabsContent>

          {seesAccounts ? (
            <TabsContent value="account">
              <PatientAccount tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
            </TabsContent>
          ) : null}

          <TabsContent value="documents">
            <Card>
              <EmptyState title="No documents" hint="Document uploads arrive in a later release." />
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function ContactItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Phone;
  label: string;
  value: string | null;
}) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5">
      <dt className="sr-only">{label}</dt>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <dd>{value}</dd>
    </div>
  );
}

function HistoryList({ label, items, tone }: { label: string; items: string[]; tone: BadgeTone }) {
  return (
    <div className="rounded-md border border-border p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="data-label">{label}</span>
        <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
      </div>
      {items.length ? (
        <ul className="flex flex-wrap gap-1">
          {items.map((item) => (
            <li key={item}>
              <Badge tone={tone} className="font-sans text-xs normal-case tracking-normal">
                {item}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">None recorded.</p>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="data-label shrink-0">{label}</span>
      <span className="text-sm sm:text-right">{value ?? <span className="text-muted-foreground">—</span>}</span>
    </div>
  );
}

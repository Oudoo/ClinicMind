import type { Metadata } from "next";
import Link from "next/link";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { Archive, ArrowLeft, Mail, MessageCircle, Phone, ScrollText, Users } from "lucide-react";
import { db, withTenant } from "@/lib/db";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { clientIp, userAgent } from "@/lib/auth/request";
import { getPatient, historyLists } from "@/modules/patients/service";
import { auditHref } from "@/modules/audit/query";
import { recordPatientView } from "@/modules/audit/views";
import { ageFrom, formatCalendarDate, formatDate, formatTime, initials } from "@/lib/utils";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AppointmentStatusBadge } from "@/components/clinicmind/appointment-status";
import { PatientHeaderActions } from "@/components/clinicmind/patient-actions";
import { MedicalHistoryEditor } from "@/components/clinicmind/patient-history-editor";
import { PatientTimeline } from "@/components/clinicmind/patient-timeline";
import { PatientVisitsTable, type VisitRow } from "@/components/clinicmind/patient-visits-table";
import { PatientNextAppointment } from "@/components/clinicmind/patient-next-appointment";
import { PatientRecalls } from "@/components/clinicmind/patient-recalls";
import { PatientConciergeCard } from "@/components/clinicmind/patient-concierge-card";
import { PatientFinanceCard } from "@/components/clinicmind/patient-finance-card";
import { PatientQuotesCard } from "@/components/clinicmind/patient-quotes-card";
import { PatientInstalmentsCard } from "@/components/clinicmind/patient-instalments-card";
import { PatientLabCard } from "@/components/clinicmind/patient-lab-card";
import { PatientInsuranceCard } from "@/components/clinicmind/patient-insurance-card";
import { PatientLeadCard } from "@/components/clinicmind/patient-lead-card";
import { PatientIntakeCard } from "@/components/clinicmind/patient-intake-card";
import { PatientAccount } from "@/components/clinicmind/patient-account";
import { BalanceChip } from "@/components/clinicmind/patient-balance";
import { canSeeAccounts, patientBalances } from "@/modules/finance/ledger";
import { getHousehold } from "@/modules/finance/household";
import { getTenantTimezone } from "@/modules/appointments/service";
import { LIVE_STATUSES } from "@/modules/appointments/transitions";
import { pregnancyLine } from "@/modules/patients/pregnancy";
import { weightLine } from "@/modules/patients/weight";
import { GENDER_LABELS, languageLabel, patientFormValues } from "@/components/clinicmind/patient-shared";

export const dynamic = "force-dynamic";

/** The "Next appointment" card shows the next live booking and three more after it. */
const SHOWN_BY_NEXT_CARD = 4;

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

/**
 * One patient's record. The header says who they are; the overview opens on what is next
 * (the next appointment, the recalls), then the clinical facts, then money and plans; the
 * other tabs hold the history (timeline, visits), the account and the documents.
 */
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
  const visits = patient._count.visits;
  // What the patient owes and who pays for them: for the roles that take payments and the owner.
  const seesAccounts = canSeeAccounts(ctx.role);
  const [balance, household] = seesAccounts
    ? await Promise.all([patientBalances(db, ctx.tenantId, [patient.id]).then((b) => b.get(patient.id) ?? 0), getHousehold(ctx.tenantId, patient.id)])
    : [null, null];
  const timezone = await getTenantTimezone(ctx.tenantId);
  // The bookings ahead are on the "Next appointment" card; this list is only for what it cannot show
  // (more than four, or a booking that is not live, such as a waitlisted one).
  const upcoming = patient.upcomingAppointments;
  const showUpcoming = upcoming.length > SHOWN_BY_NEXT_CARD || upcoming.some((a) => !(LIVE_STATUSES as readonly string[]).includes(a.status));

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

  const who = [GENDER_LABELS[patient.gender], age !== null ? `${age} ${age === 1 ? "year" : "years"}` : "age unknown", patient.dateOfBirth ? `born ${formatCalendarDate(patient.dateOfBirth)}` : null, languageLabel(patient.language)]
    .filter(Boolean)
    .join(" · ");
  const seen = [
    visits ? `${visits} ${visits === 1 ? "visit" : "visits"}${lastVisit ? `, the last on ${formatDate(lastVisit.createdAt)}` : ""}` : "No visit yet",
    `registered ${formatDate(patient.createdAt)}`,
  ].join(" · ");

  return (
    <div className="space-y-6">
      <Link href="/dashboard/patients" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Patients
      </Link>

      {/* Who the patient is: name, state, the facts the desk reads before anything else. */}
      <Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-accent-muted text-base font-medium text-accent">
              {initials(patient.fullName)}
            </span>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="font-display text-[1.375rem] font-semibold leading-7 tracking-[-0.02em]">{patient.fullName}</h1>
                {archived ? (
                  <Badge className="gap-1">
                    <Archive className="h-3 w-3" aria-hidden="true" />
                    Archived
                  </Badge>
                ) : null}
                <BalanceChip balance={balance} />
              </div>
              <p className="text-sm text-muted-foreground">{who}</p>
              <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
                <ContactItem icon={Phone} label="Phone" value={patient.phone} />
                <ContactItem icon={MessageCircle} label="WhatsApp" value={patient.whatsapp} />
                <ContactItem icon={Mail} label="E-mail" value={patient.email} />
              </dl>
              <p className="text-sm text-muted-foreground">
                <span data-testid="patient-weight">{weightLine(patient, timezone)}</span>
                {patient.gender !== "MALE" ? (
                  <>
                    {" · "}
                    <span data-testid="patient-pregnancy">{pregnancyLine(patient, timezone)}</span>
                  </>
                ) : null}
              </p>
              <p className="text-sm text-muted-foreground">{seen}</p>
              {household && household.role !== "none" ? (
                <p className="flex items-center gap-1.5 text-sm">
                  <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  {household.role === "member" && household.head ? (
                    <span>
                      Paid for by{" "}
                      <Link href={`/dashboard/patients/${household.head.id}`} className="font-medium text-accent underline-offset-2 hover:underline">
                        {household.head.fullName}
                      </Link>
                    </span>
                  ) : (
                    <span>
                      Pays for {household.members.length} family {household.members.length === 1 ? "member" : "members"}
                    </span>
                  )}
                </p>
              ) : null}
              {patient.tags.length ? (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {patient.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          {canWrite ? <PatientHeaderActions patientId={patient.id} fullName={patient.fullName} archived={archived} form={patientFormValues(patient, timezone)} /> : null}
        </div>
      </Card>

      <Tabs defaultValue={asked === "account" && seesAccounts ? "account" : asked === "timeline" || asked === "visits" || asked === "documents" ? asked : "overview"}>
        <TabsList className="h-auto flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="visits">Visits &amp; consultations</TabsTrigger>
          {seesAccounts ? <TabsTrigger value="account">Account</TabsTrigger> : null}
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          {/*
           * Three blocks, in reading order on a phone: what is next, then the clinical facts and the
           * money, then the rest of the record. On a wide screen the first and the last share the
           * side column (the first row is sized to the first block, so the last sits right under it).
           */}
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3 lg:grid-rows-[auto_1fr]">
            <div className="space-y-4 lg:col-start-3 lg:row-start-1">
              <PatientNextAppointment tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              {showUpcoming ? (
                <Card className="overflow-hidden p-0">
                  <div className="px-5 pt-5">
                    <SectionTitle title="All bookings ahead" />
                  </div>
                  <ul className="mt-2 divide-y divide-border">
                    {upcoming.map((a) => {
                      const where = [a.doctor?.fullName ?? a.doctor?.email, a.clinic?.name, a.room ? `Room ${a.room}` : null].filter(Boolean);
                      return (
                        <li key={a.id} className="flex items-start justify-between gap-3 px-5 py-3">
                          <div className="min-w-0">
                            <p className="text-sm font-medium tabular-nums">
                              {formatDate(a.startsAt)} · {formatTime(a.startsAt)}–{formatTime(a.endsAt)}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{[a.reason, ...where].filter(Boolean).join(" · ")}</p>
                          </div>
                          <AppointmentStatusBadge status={a.status} />
                        </li>
                      );
                    })}
                  </ul>
                </Card>
              ) : null}
              <PatientRecalls tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} archived={archived} />
            </div>

            <div className="space-y-4 lg:col-span-2 lg:col-start-1 lg:row-span-2 lg:row-start-1">
              <Card>
                <SectionTitle title="Medical history" action={canWrite && !archived ? <MedicalHistoryEditor patientId={patient.id} history={history} /> : null} />
                <dl className="mt-3 divide-y divide-border">
                  <FactRow label="Chronic conditions" items={history.chronicConditions} />
                  <FactRow label="Allergies" items={history.allergies} />
                  <FactRow label="Diagnoses" items={history.diagnoses} />
                  <FactRow label="Surgeries" items={history.surgeries} />
                </dl>
              </Card>

              <Card className="overflow-hidden p-0">
                <div className="px-5 pt-5">
                  <SectionTitle
                    title="Medications"
                    description={activeMeds.length ? `${activeMeds.length} active, prescribed when a consultation was signed.` : "Prescribed when a consultation is signed."}
                  />
                </div>
                {activeMeds.length ? (
                  <Table className="mt-4">
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
                          <TD className="hidden whitespace-nowrap tabular-nums text-muted-foreground md:table-cell">{m.startDate ? formatDate(m.startDate) : "—"}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                ) : (
                  <p className="px-5 pb-5 pt-3 text-sm text-muted-foreground">No active medication.</p>
                )}
                {stoppedMeds.length ? (
                  <p className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
                    Stopped: {stoppedMeds.map((m) => `${m.name}${m.stoppedAt ? ` (${formatDate(m.stoppedAt)})` : ""}`).join(", ")}
                  </p>
                ) : null}
              </Card>

              <PatientLabCard tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              <PatientConciergeCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              <PatientFinanceCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              <PatientQuotesCard tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              <PatientInstalmentsCard tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              <PatientInsuranceCard tenantId={ctx.tenantId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
            </div>

            <div className="space-y-4 lg:col-start-3 lg:row-start-2">
              <Card>
                <SectionTitle title="Details" />
                <dl className="mt-2 divide-y divide-border">
                  <DetailRow label="Emergency contact" value={patient.emergencyContact} />
                  <DetailRow label="Address" value={patient.address} />
                  <DetailRow label="WhatsApp reminders" value={patient.reminderConsent ? "Agreed" : `Declined${patient.reminderConsentAt ? ` on ${formatDate(patient.reminderConsentAt)}` : ""}`} />
                  <DetailRow label="Offers and news" value={patient.marketingConsent ? `Agreed${patient.marketingConsentAt ? ` on ${formatDate(patient.marketingConsentAt)}` : ""}` : "Not agreed"} />
                  <DetailRow label="Notes" value={patient.notes} multiline />
                </dl>
                {can(ctx.role, "audit:read") ? (
                  <Link href={auditHref({ patient: patient.id })} className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                    <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
                    Who opened or changed this record
                  </Link>
                ) : null}
              </Card>
              <PatientLeadCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
              <PatientIntakeCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} patientId={patient.id} canWrite={canWrite && !archived} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="timeline">
          <Card className="overflow-hidden p-0">
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
          <EmptyState title="No documents" hint="Document uploads arrive in a later release." />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ContactItem({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-1.5">
      <dt className="sr-only">{label}</dt>
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <dd>{value}</dd>
    </div>
  );
}

/** One list of the medical history as a row: what the patient lives with is a fact, written plainly. */
function FactRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <dt className="data-label">{label}</dt>
      <dd className="text-sm">{items.length ? items.join(", ") : <span className="text-muted-foreground">None recorded</span>}</dd>
    </div>
  );
}

function DetailRow({ label, value, multiline = false }: { label: string; value: string | null; multiline?: boolean }) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] lg:grid-cols-1 xl:grid-cols-[8.5rem_minmax(0,1fr)]">
      <dt className="data-label">{label}</dt>
      <dd className={multiline ? "whitespace-pre-wrap break-words text-sm" : "break-words text-sm"}>{value || <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

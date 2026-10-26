import Link from "next/link";
import { Inbox } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getTenantTimezone, listStaff } from "@/modules/appointments/service";
import { historyLists, listOptionsFromQuery, listPatientTags, listPatients } from "@/modules/patients/service";
import { listSavedViews } from "@/modules/patients/views";
import { countPendingSubmissions } from "@/modules/intake/service";
import { parsePatientListQuery, patientListHref, patientQueryParams, hasPatientFilters } from "@/modules/patients/filters";
import { ageFrom, cn, initials } from "@/lib/utils";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AddPatientButton } from "@/components/clinicmind/patient-form-dialog";
import { PatientFilters } from "@/components/clinicmind/patient-filters";
import { GENDER_LABELS } from "@/components/clinicmind/patient-shared";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

/** A dense registry: tighter cell padding so every column fits a 1366 px laptop without scrolling the table. */
const DENSE = "px-3 sm:px-3";

/**
 * `/dashboard/patients` — the registry with server-side, URL-synced filters
 * and sorting (see `@/modules/patients/filters` for the query vocabulary).
 * The page parses `searchParams`, the client filter bar only rewrites the URL.
 */
export default async function PatientsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const query = parsePatientListQuery(sp);
  const canWrite = can(ctx.role, "patients:write");
  const timezone = await getTenantTimezone(ctx.tenantId);
  const [result, doctors, tags, views, pendingIntake] = await Promise.all([
    listPatients(ctx.tenantId, listOptionsFromQuery(query, timezone)),
    listStaff(ctx.tenantId),
    listPatientTags(ctx.tenantId),
    ctx.userId ? listSavedViews(ctx.tenantId, ctx.userId) : Promise.resolve([]),
    canWrite ? countPendingSubmissions(ctx.tenantId) : Promise.resolve(0),
  ]);
  const { patients, total, pageSize } = result;
  const filtered = hasPatientFilters(query);
  const paginationQuery = Object.fromEntries(patientQueryParams({ ...query, page: undefined }));
  const date = (d: Date | null) => (d ? formatDateInTz(d, timezone) : null);

  return (
    <>
      <div className="space-y-6">
        <SectionTitle
          title="Patients"
          description="Unified patient registry with clinical context."
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Badge tone="accent">
                {total} {total === 1 ? "record" : "records"}
              </Badge>
              {canWrite ? (
                <Button asChild variant="outline" size="sm">
                  <Link href="/dashboard/patients/intake" title="Onboarding links and submitted forms">
                    <Inbox className="h-4 w-4" />
                    Onboarding
                    {pendingIntake > 0 ? <Badge tone="warning">{pendingIntake}</Badge> : null}
                  </Link>
                </Button>
              ) : null}
              {canWrite ? <AddPatientButton /> : null}
            </div>
          }
        />

        <Card className="overflow-hidden p-0">
          <PatientFilters
            query={query}
            total={total}
            doctors={doctors.map((d) => ({ id: d.id, fullName: d.fullName }))}
            tags={tags}
            views={views.map((v) => ({ id: v.id, name: v.name, params: v.params }))}
            canSaveViews={Boolean(ctx.userId)}
            canExport={can(ctx.role, "patients:export")}
          />

          {patients.length ? (
            <Table>
              <THead>
                <TR className="hover:bg-transparent">
                  <TH className={DENSE}>Patient</TH>
                  <TH className={DENSE}>Age</TH>
                  <TH className={DENSE}>Contact</TH>
                  <TH className={cn(DENSE, "hidden md:table-cell")}>City · tags</TH>
                  <TH className={cn(DENSE, "hidden xl:table-cell")}>Conditions</TH>
                  <TH className={cn(DENSE, "hidden xl:table-cell")}>Last visit</TH>
                  <TH className={cn(DENSE, "hidden lg:table-cell")}>Next appointment</TH>
                </TR>
              </THead>
              <TBody>
                {patients.map((p) => {
                  const conditions = historyLists(p.medicalHistory).chronicConditions;
                  const age = ageFrom(p.dateOfBirth);
                  return (
                    <TR key={p.id} className={p.exact ? "bg-accent-muted/40" : undefined}>
                      <TD className={DENSE}>
                        <div className="flex min-w-[9rem] items-center gap-3">
                          <span
                            aria-hidden="true"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-muted font-mono text-xs text-accent"
                          >
                            {initials(p.fullName)}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <Link
                                href={`/dashboard/patients/${p.id}`}
                                className="font-medium underline-offset-2 hover:text-accent hover:underline"
                              >
                                {p.fullName}
                              </Link>
                              {p.exact ? <Badge tone="success">Exact match</Badge> : null}
                              {p.deletedAt ? <Badge tone="danger">archived</Badge> : null}
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {GENDER_LABELS[p.gender]}
                              {p.nationalId ? <span className="font-mono"> · ID {p.nationalId}</span> : null}
                            </p>
                          </div>
                        </div>
                      </TD>
                      <TD className={cn(DENSE, "font-mono tabular-nums text-muted-foreground")}>{age ?? "—"}</TD>
                      <TD className={cn(DENSE, "font-mono text-xs text-muted-foreground")}>
                        <div className="whitespace-nowrap">{p.phone ?? "—"}</div>
                        {p.email ? (
                          <div className="hidden max-w-[10rem] truncate md:block" title={p.email}>
                            {p.email}
                          </div>
                        ) : null}
                      </TD>
                      <TD className={cn(DENSE, "hidden md:table-cell")}>
                        <div className="space-y-1">
                          {p.city ? <div className="text-xs">{p.city}</div> : null}
                          <div className="flex flex-wrap gap-1">
                            {p.tags.map((t) => (
                              <Link key={t} href={patientListHref({ ...query, tag: t, page: undefined })} aria-label={`Filter by tag ${t}`}>
                                <Badge tone={t === query.tag ? "accent" : "default"}>{t}</Badge>
                              </Link>
                            ))}
                          </div>
                        </div>
                      </TD>
                      <TD className={cn(DENSE, "hidden xl:table-cell")}>
                        <div className="flex flex-wrap gap-1">
                          {conditions.slice(0, 2).map((c) => (
                            <Badge key={c} tone="warning" className="max-w-[10rem]" title={c}>
                              <span className="min-w-0 truncate">{c}</span>
                            </Badge>
                          ))}
                          {conditions.length > 2 ? <Badge>+{conditions.length - 2}</Badge> : null}
                        </div>
                      </TD>
                      <TD className={cn(DENSE, "hidden whitespace-nowrap font-mono text-xs text-muted-foreground xl:table-cell")}>
                        {date(p.lastVisitAt) ?? "—"}
                        <div className="text-[11px]">{p._count.visits} {p._count.visits === 1 ? "visit" : "visits"}</div>
                      </TD>
                      <TD className={cn(DENSE, "hidden whitespace-nowrap font-mono text-xs text-muted-foreground lg:table-cell")}>
                        {p.nextAppointmentAt ? (
                          <>
                            {date(p.nextAppointmentAt)}
                            <div className="text-[11px]">
                              {formatTimeInTz(p.nextAppointmentAt, timezone)}
                              {p.upcomingCount > 1 ? ` · +${p.upcomingCount - 1} more` : ""}
                            </div>
                          </>
                        ) : (
                          "—"
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          ) : (
            <div className="p-6">
              <EmptyState
                title={filtered ? "No patients match" : "No patients yet"}
                hint={
                  filtered
                    ? "Try another name, phone number or national ID, or clear the filters."
                    : canWrite
                      ? "Add your first patient to start building their record."
                      : "Patients registered by the front desk or the AI receptionist appear here."
                }
              />
            </div>
          )}

          {total > 0 ? (
            <Pagination
              page={result.page}
              pageSize={pageSize}
              total={total}
              basePath="/dashboard/patients"
              query={paginationQuery}
              className="border-t border-border"
            />
          ) : null}
        </Card>
      </div>
    </>
  );
}

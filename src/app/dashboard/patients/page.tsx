import Link from "next/link";
import { Inbox } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getTenantTimezone, listStaff } from "@/modules/appointments/service";
import { historyLists, listOptionsFromQuery, listPatientTags, listPatients } from "@/modules/patients/service";
import { listSavedViews } from "@/modules/patients/views";
import { countPendingSubmissions } from "@/modules/intake/service";
import { parsePatientListQuery, patientListHref, patientQueryParams, hasPatientFilters } from "@/modules/patients/filters";
import { ageFrom, cn } from "@/lib/utils";
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

/** Tighter cells between the columns, so every column fits a 1366 px laptop; the row's ends keep the card's inset. */
const CELL = "px-3 first:ps-4 last:pe-4 sm:px-3 sm:first:ps-5 sm:last:pe-5";

/**
 * `/dashboard/patients`: the patient list with server-side, URL-synced filters
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
    <div className="space-y-4">
      <SectionTitle
        title="Patients"
        action={
          canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline">
                <Link href="/dashboard/patients/intake" title="Onboarding links and the forms patients sent back">
                  <Inbox className="h-4 w-4" />
                  Onboarding
                  {pendingIntake > 0 ? (
                    <Badge tone="warning" className="tabular-nums">
                      {pendingIntake} to review
                    </Badge>
                  ) : null}
                </Link>
              </Button>
              <AddPatientButton />
            </div>
          ) : null
        }
      />

      {/* The controls of the list below, not a panel of their own. */}
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
        <Card className="overflow-hidden p-0">
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH className={CELL}>Patient</TH>
                <TH className={CELL}>Contact</TH>
                <TH className={cn(CELL, "hidden md:table-cell")}>City and tags</TH>
                <TH className={cn(CELL, "hidden xl:table-cell")}>Conditions</TH>
                <TH className={cn(CELL, "hidden xl:table-cell")}>Last visit</TH>
                <TH className={cn(CELL, "hidden lg:table-cell")}>Next appointment</TH>
              </TR>
            </THead>
            <TBody>
              {patients.map((p) => {
                const conditions = historyLists(p.medicalHistory).chronicConditions;
                const age = ageFrom(p.dateOfBirth);
                return (
                  <TR key={p.id} className={p.exact ? "bg-accent-muted/40" : undefined}>
                    <TD className={CELL}>
                      <div className="flex min-w-[8rem] flex-wrap items-center gap-x-2 gap-y-1">
                        <Link href={`/dashboard/patients/${p.id}`} className="font-medium underline-offset-2 hover:text-accent hover:underline">
                          {p.fullName}
                        </Link>
                        {p.exact ? <Badge tone="accent">Exact match</Badge> : null}
                        {p.deletedAt ? <Badge>Archived</Badge> : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {GENDER_LABELS[p.gender]}
                        {age !== null ? <span className="tabular-nums"> · {age} {age === 1 ? "year" : "years"}</span> : null}
                        {p.nationalId ? <span className="hidden font-mono sm:inline"> · ID {p.nationalId}</span> : null}
                      </p>
                    </TD>
                    <TD className={cn(CELL, "tabular-nums")}>
                      <div className="whitespace-nowrap">{p.phone ?? <span className="text-muted-foreground">No phone</span>}</div>
                      {p.email ? (
                        <div className="hidden max-w-[11rem] truncate text-xs text-muted-foreground md:block" title={p.email}>
                          {p.email}
                        </div>
                      ) : null}
                    </TD>
                    <TD className={cn(CELL, "hidden md:table-cell")}>
                      {p.city ? <div>{p.city}</div> : null}
                      {p.tags.length ? (
                        <div className={cn("flex flex-wrap gap-1", p.city && "mt-1")}>
                          {p.tags.map((t) => (
                            <Link key={t} href={patientListHref({ ...query, tag: t, page: undefined })} aria-label={`Filter by tag ${t}`} className="rounded-md">
                              <Badge tone={t === query.tag ? "accent" : "default"} className="hover:text-foreground">
                                {t}
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      ) : null}
                      {!p.city && !p.tags.length ? <span className="text-muted-foreground">—</span> : null}
                    </TD>
                    {/* What the patient lives with is a fact of the record, not a warning: plain text. */}
                    <TD className={cn(CELL, "hidden max-w-[16rem] xl:table-cell")}>
                      {conditions.length ? (
                        <span className="line-clamp-2" title={conditions.join(", ")}>
                          {conditions.slice(0, 2).join(", ")}
                          {conditions.length > 2 ? <span className="text-muted-foreground"> and {conditions.length - 2} more</span> : null}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                    <TD className={cn(CELL, "hidden whitespace-nowrap tabular-nums xl:table-cell")}>
                      {p.lastVisitAt ? (
                        <>
                          {date(p.lastVisitAt)}
                          <div className="text-xs text-muted-foreground">
                            {p._count.visits} {p._count.visits === 1 ? "visit" : "visits"}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{p._count.visits ? `${p._count.visits} ${p._count.visits === 1 ? "visit" : "visits"}` : "No visit yet"}</span>
                      )}
                    </TD>
                    <TD className={cn(CELL, "hidden whitespace-nowrap tabular-nums lg:table-cell")}>
                      {p.nextAppointmentAt ? (
                        <>
                          {date(p.nextAppointmentAt)}
                          <div className="text-xs text-muted-foreground">
                            {formatTimeInTz(p.nextAppointmentAt, timezone)}
                            {p.upcomingCount > 1 ? ` · ${p.upcomingCount - 1} more after it` : ""}
                          </div>
                        </>
                      ) : (
                        <span className="text-muted-foreground">None booked</span>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
          <Pagination page={result.page} pageSize={pageSize} total={total} basePath="/dashboard/patients" query={paginationQuery} className="border-t border-border" />
        </Card>
      ) : (
        <EmptyState
          title={filtered ? "No patients match" : "No patients yet"}
          hint={
            filtered
              ? "Try another name, phone number or national ID, or clear the filters."
              : canWrite
                ? "Add the first patient to start their record."
                : "Patients added by the front desk appear here."
          }
        />
      )}
    </div>
  );
}

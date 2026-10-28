import type { Metadata } from "next";
import Link from "next/link";
import { Filter } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { getTenantTimezone } from "@/modules/appointments/service";
import {
  ENTITY_LABELS,
  auditExportHref,
  auditHref,
  auditQueryParams,
  describeDevice,
  fieldLabel,
  hasAuditFilters,
  parseAuditQuery,
} from "@/modules/audit/query";
import { listAuditLogs, listAuditPeople, type AuditRow } from "@/modules/audit/service";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Pagination } from "@/components/ui/pagination";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { AuditFilters } from "@/components/clinicmind/audit-filters";
import { CsvLink, NotForRole } from "@/components/clinicmind/report-shared";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit log" };

type SearchParams = Record<string, string | string[] | undefined>;

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Platform admin",
  CLINIC_OWNER: "Owner",
  DOCTOR: "Doctor",
  NURSE: "Nurse",
  RECEPTIONIST: "Reception",
  ASSISTANT: "Assistant",
};

const ACTION_TONE: [RegExp, "danger" | "warning" | "success" | "accent"][] = [
  [/(login_failed|safety_override|void|archive|delete|discard|cancel|revoke|reject|lost)$/, "danger"],
  [/(export|clinician|status|role)$/, "warning"],
  [/(sign|accept|convert|restore)$/, "success"],
];

function actionTone(action: string) {
  return ACTION_TONE.find(([re]) => re.test(action))?.[1] ?? "default";
}

/** Where an entry's record lives in the app, when it has a page. */
function recordHref(row: AuditRow): string | null {
  if (row.patient) return `/dashboard/patients/${row.patient.id}`;
  if (row.entity === "Lead" && row.entityId) return `/dashboard/leads/${row.entityId}`;
  if (row.entity === "Conversation" && row.entityId) return `/dashboard/conversations?c=${row.entityId}`;
  return null;
}

/**
 * `/dashboard/audit` — the clinic's audit log for the owner (`audit:read`):
 * every change to records and settings, sign-ins, exports and record views,
 * searchable by person, patient, activity and date, exportable to CSV.
 * Entries cannot be edited or deleted (enforced by the database).
 */
export default async function AuditLogPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "audit:read")) {
    return (
      <div className="space-y-6">
        <SectionTitle title="Audit log" />
        <NotForRole title="Not available for your role" hint="The audit log is for the clinic owner." />
      </div>
    );
  }

  const timezone = await getTenantTimezone(ctx.tenantId);
  const query = parseAuditQuery(sp);
  const [result, people, patient] = await Promise.all([
    listAuditLogs(ctx.tenantId, query, timezone),
    listAuditPeople(ctx.tenantId),
    query.patient
      ? db.patient.findFirst({ where: { id: query.patient, tenantId: ctx.tenantId }, select: { id: true, fullName: true } })
      : Promise.resolve(null),
  ]);
  const { rows, total, page, pageSize } = result;
  const filtered = hasAuditFilters(query);
  const paginationQuery = Object.fromEntries(auditQueryParams({ ...query, page: undefined }));

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Audit log"
        description="Who did what, and when: every change to records and settings, sign-ins and exports. Entries cannot be edited or deleted."
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone="accent">
              {total} {total === 1 ? "entry" : "entries"}
            </Badge>
            {total > 0 ? <CsvLink href={auditExportHref(query)} label="Export CSV" /> : null}
          </div>
        }
      />

      <Card className="overflow-hidden p-0">
        <AuditFilters query={query} people={people} patient={patient} />

        {rows.length ? (
          <Table>
            <THead>
              <TR className="hover:bg-transparent">
                <TH className="w-28">When</TH>
                <TH className="hidden md:table-cell">Person</TH>
                <TH>Action</TH>
                <TH className="hidden lg:table-cell">Record</TH>
                <TH className="hidden xl:table-cell">From</TH>
              </TR>
            </THead>
            <TBody>
              {rows.map((row) => {
                const href = recordHref(row);
                return (
                  <TR key={row.id} className="align-top">
                    <TD className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      <div>{formatDateInTz(row.createdAt, timezone)}</div>
                      <div>{formatTimeInTz(row.createdAt, timezone)}</div>
                    </TD>
                    <TD className="hidden md:table-cell">
                      <PersonCell row={row} query={query} />
                    </TD>
                    <TD>
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{row.label}</span>
                          <Badge tone={actionTone(row.action)} className="font-mono">
                            {row.action}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground md:hidden">{row.actor.name}</div>
                        <div className="text-xs lg:hidden">
                          <RecordLink row={row} href={href} />
                        </div>
                        <Changes row={row} />
                      </div>
                    </TD>
                    <TD className="hidden lg:table-cell">
                      <div className="flex flex-col gap-1 text-xs">
                        <RecordLink row={row} href={href} />
                        {row.patient ? (
                          <Link
                            href={auditHref({ ...query, patient: row.patient.id, page: undefined })}
                            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                            title={`Show only entries about ${row.patient.fullName}`}
                          >
                            <Filter className="h-3 w-3" aria-hidden="true" /> Only this patient
                          </Link>
                        ) : null}
                      </div>
                    </TD>
                    <TD className="hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell">
                      <div className="font-mono">{row.ip ?? "—"}</div>
                      {row.device ? (
                        <div className="max-w-[10rem] truncate" title={row.device}>
                          {describeDevice(row.device)}
                        </div>
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        ) : (
          <div className="p-6">
            <EmptyState
              title={filtered ? "No entries match" : "No entries yet"}
              hint={filtered ? "Widen the dates or clear a filter." : "Changes to records and settings appear here as soon as they happen."}
            />
          </div>
        )}

        {total > 0 ? (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            basePath="/dashboard/audit"
            query={paginationQuery}
            className="border-t border-border"
          />
        ) : null}
      </Card>
    </div>
  );
}

function PersonCell({ row, query }: { row: AuditRow; query: Parameters<typeof auditHref>[0] }) {
  const value = row.actor.id ?? "system";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Link
        href={auditHref({ ...query, actor: value, page: undefined })}
        className="truncate font-medium underline-offset-2 hover:text-accent hover:underline"
        title={`Show only entries by ${row.actor.name}`}
      >
        {row.actor.name}
      </Link>
      {row.actor.role ? <span className="text-xs text-muted-foreground">{ROLE_LABELS[row.actor.role] ?? row.actor.role}</span> : null}
      {row.actor.email && row.actor.email !== row.actor.name ? (
        <span className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground" title={row.actor.email}>
          {row.actor.email}
        </span>
      ) : null}
    </div>
  );
}

function RecordLink({ row, href }: { row: AuditRow; href: string | null }) {
  const kind = ENTITY_LABELS[row.entity] ?? row.entity;
  const text = row.patient
    ? row.patient.fullName
    : row.subject
      ? `${kind}: ${row.subject}`
      : row.entity === "Tenant" || !row.entityId
        ? kind
        : `${kind} · ${row.entityId.slice(0, 10)}`;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {href ? (
        <Link href={href} className="font-medium text-accent underline-offset-2 hover:underline">
          {text}
        </Link>
      ) : (
        <span className="font-mono text-muted-foreground">{text}</span>
      )}
      {row.patient?.archived ? <Badge tone="danger">archived</Badge> : null}
      {row.patient && row.entity !== "Patient" ? <span className="text-muted-foreground">· {kind}</span> : null}
    </span>
  );
}

function Changes({ row }: { row: AuditRow }) {
  if (!row.changes.length && row.before == null && row.after == null) return null;
  const shown = row.changes.slice(0, 3);
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground">
        <span className="underline-offset-2 group-open:underline">
          {row.changes.length ? `${row.changes.length} ${row.changes.length === 1 ? "detail" : "details"}` : "Details"}
        </span>
        {shown.length ? (
          <span className="ml-1 hidden text-muted-foreground sm:inline">
            ({shown.map((c) => fieldLabel(c.field)).join(", ")}
            {row.changes.length > shown.length ? ", …" : ""})
          </span>
        ) : null}
      </summary>
      <div className="mt-2 space-y-2 rounded-md border border-border bg-muted/40 p-2">
        {row.changes.length ? (
          <dl className="grid grid-cols-1 gap-x-3 gap-y-1 sm:grid-cols-[minmax(6rem,auto)_1fr]">
            {row.changes.map((c) => (
              <div key={c.field} className="contents">
                <dt className="font-medium text-muted-foreground">{fieldLabel(c.field)}</dt>
                <dd className={cn("min-w-0 break-words")}>
                  {c.from !== null ? <span className="text-muted-foreground line-through decoration-danger/60">{c.from}</span> : null}
                  {c.from !== null && c.to !== null ? " → " : null}
                  {c.to !== null ? <span>{c.to}</span> : c.from !== null ? <span className="text-muted-foreground"> (removed)</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="font-mono text-[11px] text-muted-foreground">
          Entry {row.id}
          {row.entityId ? ` · ${row.entity} ${row.entityId}` : ""}
        </p>
      </div>
    </details>
  );
}

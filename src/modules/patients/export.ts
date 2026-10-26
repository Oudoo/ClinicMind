import { audit } from "@/lib/audit";
import { ageFrom } from "@/lib/utils";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { patientFiltersOnly, type PatientListQuery } from "@/modules/patients/filters";
import { listOptionsFromQuery, listPatientsForExport, type Actor, type PatientListRow } from "@/modules/patients/service";

/**
 * CSV export of the filtered patient list (same query as the page), capped at
 * 5,000 rows. The file starts with a UTF-8 byte-order mark so Excel opens
 * Arabic names correctly without an import wizard; cells that a spreadsheet
 * would evaluate as a formula are neutralised, and phone numbers are written
 * as text so `+2010…` is not turned into 2.01E+11.
 */
export const EXPORT_COLUMNS = [
  "Name",
  "Gender",
  "Age",
  "Phone",
  "WhatsApp",
  "E-mail",
  "National ID",
  "City",
  "Language",
  "Tags",
  "Registered",
  "Last visit",
  "Next appointment",
  "Upcoming appointments",
  "Visits",
] as const;

const BOM = "﻿";

/**
 * Quote a cell for CSV and defuse spreadsheet formula injection: any text
 * starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed
 * with `'` (OWASP), so a name like `-2+3` or `=HYPERLINK(…)` stays text.
 * Numbers are written as numbers.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let text = value;
  if (/^\+\d{6,}$/.test(text)) {
    // Phone numbers: keep them as text in Excel / Sheets / LibreOffice.
    return `"=""${text}"""`;
  }
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Phones and national ids: a long run of digits is written as a text formula
 * so the spreadsheet keeps the leading `+` / `0` and never shows a 14-digit
 * national id as 2.9E+13.
 */
export function csvTextCell(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\+?\d{6,20}$/.test(value)) return `"=""${value}"""`;
  return csvCell(value);
}

export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",");
}

function dateCell(d: Date | null | undefined, timezone: string): string {
  return d ? formatDateInTz(d, timezone, { year: "numeric", month: "2-digit", day: "2-digit" }) : "";
}

function dateTimeCell(d: Date | null | undefined, timezone: string): string {
  return d ? `${dateCell(d, timezone)} ${formatTimeInTz(d, timezone)}` : "";
}

export function patientCsvRow(p: PatientListRow, timezone: string): string {
  return [
    csvCell(p.fullName),
    csvCell(p.gender),
    csvCell(ageFrom(p.dateOfBirth)),
    csvTextCell(p.phone),
    csvTextCell(p.whatsapp),
    csvCell(p.email),
    csvTextCell(p.nationalId),
    csvCell(p.city),
    csvCell(p.language),
    csvCell(p.tags.join("; ")),
    csvCell(dateCell(p.createdAt, timezone)),
    csvCell(dateCell(p.lastVisitAt, timezone)),
    csvCell(dateTimeCell(p.nextAppointmentAt, timezone)),
    csvCell(p.upcomingCount),
    csvCell(p._count.visits),
  ].join(",");
}

export interface PatientCsvExport {
  csv: string;
  rows: number;
  /** True when the filtered set was larger than the cap. */
  truncated: boolean;
  filename: string;
}

/** Build the CSV for a validated list query and record the export in the audit trail. */
export async function exportPatientsCsv(tenantId: string, query: PatientListQuery, actor: Actor = {}): Promise<PatientCsvExport> {
  const timezone = await getTenantTimezone(tenantId);
  const now = new Date();
  const page = await listPatientsForExport(tenantId, listOptionsFromQuery(query, timezone, now));
  const lines = [csvLine(EXPORT_COLUMNS), ...page.patients.map((p) => patientCsvRow(p, timezone))];
  const csv = `${BOM}${lines.join("\r\n")}\r\n`;
  const filters = patientFiltersOnly(query);
  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "patient.export",
    entity: "Patient",
    after: { filters, rows: page.patients.length, total: page.total, format: "csv" },
  });
  const stamp = formatDateInTz(now, timezone, { year: "numeric", month: "2-digit", day: "2-digit" }).replace(/\//g, "-");
  return { csv, rows: page.patients.length, truncated: page.total > page.patients.length, filename: `patients-${stamp}.csv` };
}

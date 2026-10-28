/**
 * CSV helpers for the export endpoints. RFC 4180 quoting; a UTF-8 BOM so
 * Excel opens Arabic names correctly. No server imports.
 */
export type CsvCell = string | number | boolean | Date | null | undefined;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : typeof value === "number" ? String(value) : String(value);
  // A spreadsheet would run text starting with = + - @ (or a tab / carriage
  // return) as a formula, e.g. a patient named =HYPERLINK(…); keep it text (OWASP).
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Data rows in a file produced by `toCsv` (the header is not counted). */
export function csvRowCount(csv: string): number {
  return Math.max(0, csv.split("\r\n").filter(Boolean).length - 1);
}

export function csvResponse(filename: string, csv: string): Response {
  const safe = filename.replace(/[^a-z0-9._-]+/gi, "-");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Cache-Control": "no-store",
    },
  });
}

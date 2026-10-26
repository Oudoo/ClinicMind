import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, notDeleted } from "@/lib/db";
import { audit } from "@/lib/audit";
import { TenantScopeError } from "@/lib/tenant-scope";
import { zonedTimeToUtc } from "@/lib/time";
import { zDateTime, zOptionalText, zText } from "@/lib/validation";
import { getTenantTimezone } from "@/modules/appointments/service";
import { KIND_LABELS, MAX_AMOUNT, METHOD_LABELS, PAYMENT_KINDS, PAYMENT_METHODS, type PaymentKindValue, type PaymentMethodValue } from "./constants";
import type { Actor } from "./procedures";

/**
 * POS CSV import: the front desk pastes (or uploads) the day's export from the
 * card terminal / POS software, the server matches each row to a patient by
 * phone (Arabic digits normalised), shows a preview with the problems, and the
 * confirmed rows become payments under one import batch id.
 */

export const MAX_IMPORT_ROWS = 2000;
export const MAX_CSV_BYTES = 1_000_000;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → ASCII; Arabic decimal/thousands separators → ASCII. */
export function normaliseDigits(text: string): string {
  let out = "";
  for (const ch of text) {
    const a = ARABIC_INDIC.indexOf(ch);
    const e = EXTENDED_ARABIC_INDIC.indexOf(ch);
    if (a !== -1) out += String(a);
    else if (e !== -1) out += String(e);
    else if (ch === "٫") out += ".";
    else if (ch === "٬" || ch === "،") out += ",";
    else out += ch;
  }
  return out;
}

/**
 * Phone text → `+20XXXXXXXXXX`-style number, or null when it is not a phone.
 * Accepts `010 1234 5678`, `0020…`, `20…`, `+20…` and Arabic digits. Numbers
 * of other countries keep their own country code.
 */
export function normalisePhone(raw: string): string | null {
  let digits = normaliseDigits(raw).replace(/[^\d+]/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = `+${digits.slice(2)}`;
  const plus = digits.startsWith("+");
  digits = digits.replace(/\+/g, "");
  if (!/^\d+$/.test(digits)) return null;
  let e164: string;
  if (plus) e164 = `+${digits}`;
  else if (digits.length === 11 && digits.startsWith("01")) e164 = `+20${digits.slice(1)}`;
  else if (digits.length === 12 && digits.startsWith("201")) e164 = `+${digits}`;
  else if (digits.length === 10 && digits.startsWith("1")) e164 = `+20${digits}`;
  else e164 = `+${digits}`;
  const n = e164.length - 1;
  return n >= 8 && n <= 15 ? e164 : null;
}

/** The spellings a patient's stored phone might use for the same number. */
export function phoneVariants(e164: string): string[] {
  const digits = e164.replace(/^\+/, "");
  const out = new Set<string>([e164, digits, `00${digits}`]);
  if (digits.startsWith("20") && digits.length === 12) out.add(`0${digits.slice(2)}`);
  return [...out];
}

/** Minimal RFC 4180 parser with delimiter detection (comma, semicolon, tab). */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^﻿/, "");
  const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

const COLUMN_ALIASES: Record<string, string[]> = {
  date: ["date", "paid", "paid_at", "paidat", "datetime", "time", "تاريخ", "التاريخ"],
  phone: ["phone", "mobile", "tel", "telephone", "msisdn", "whatsapp", "هاتف", "موبايل", "تليفون", "الهاتف"],
  amount: ["amount", "total", "value", "sum", "egp", "مبلغ", "المبلغ", "القيمة"],
  kind: ["kind", "type", "category", "نوع", "النوع"],
  method: ["method", "payment method", "payment_method", "paymentmethod", "channel", "طريقة", "طريقة الدفع"],
  reference: ["reference", "ref", "receipt", "receipt no", "transaction", "txn", "رقم", "مرجع", "الإيصال"],
  name: ["name", "patient", "customer", "client", "اسم", "الاسم", "المريض"],
};

/** Map header cells to the known columns; null when the header is not recognisable. */
export function mapColumns(header: string[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  header.forEach((h, i) => {
    const key = h.trim().toLowerCase();
    for (const [column, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (out[column] === undefined && aliases.includes(key)) out[column] = i;
    }
  });
  return out.date !== undefined && out.amount !== undefined && out.phone !== undefined ? out : null;
}

export function parseKind(text: string | undefined): PaymentKindValue {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return "PAYMENT";
  if (/deposit|advance|عربون|مقدم/.test(t)) return "DEPOSIT";
  if (/refund|return|استرداد|مرتجع/.test(t)) return "REFUND";
  if (/consult|fee|كشف|استشارة/.test(t)) return "CONSULTATION_FEE";
  return "PAYMENT";
}

export function parseMethod(text: string | undefined): PaymentMethodValue {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return "POS";
  if (/cash|نقد|كاش/.test(t)) return "CASH";
  if (/card|visa|master|meeza|credit|debit|بطاقة|فيزا/.test(t)) return "CARD";
  if (/transfer|bank|iban|تحويل|بنك/.test(t)) return "BANK_TRANSFER";
  if (/wallet|vodafone|instapay|fawry|orange|etisalat|محفظة|فودافون/.test(t)) return "WALLET";
  if (/pos|terminal|ماكينة/.test(t)) return "POS";
  return "OTHER";
}

/** `YYYY-MM-DD[ HH:mm]`, `DD/MM/YYYY[ HH:mm]` or `DD-MM-YYYY` on the clinic clock; noon when no time is given. */
export function parseImportDate(text: string, timeZone: string): Date | null {
  const t = normaliseDigits(text).trim();
  let y: number, m: number, d: number;
  let hour = 12;
  let minute = 0;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(t);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2}))?/.exec(t);
    if (!match) return null;
    d = Number(match[1]);
    m = Number(match[2]);
    y = Number(match[3]);
  }
  if (match[4] !== undefined) {
    hour = Number(match[4]);
    minute = Number(match[5]);
  }
  if (m < 1 || m > 12 || d < 1 || d > 31 || hour > 23 || minute > 59) return null;
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return zonedTimeToUtc({ year: y, month: m, day: d, hour, minute }, timeZone);
}

export function parseAmount(text: string): number | null {
  const t = normaliseDigits(text).replace(/[^\d.,-]/g, "").replace(/,/g, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const whole = Math.round(Math.abs(n));
  return whole;
}

export interface ParsedImportRow {
  line: number;
  paidAt: Date | null;
  dateText: string;
  phone: string | null;
  phoneText: string;
  amount: number | null;
  kind: PaymentKindValue;
  method: PaymentMethodValue;
  reference: string | null;
  name: string | null;
  problems: string[];
}

/** Parse the CSV text into rows with per-row problems. Pure: no database. */
export function parseImportRows(text: string, timeZone: string): { rows: ParsedImportRow[]; error: string | null } {
  const table = parseCsv(text);
  if (!table.length) return { rows: [], error: "The file is empty." };
  const header = table[0]!;
  let columns = mapColumns(header);
  let body = table.slice(1);
  const hasHeader = columns !== null;
  if (!columns) {
    // No recognisable header: assume the documented order (date, phone, amount, kind, method, reference, name).
    columns = { date: 0, phone: 1, amount: 2, kind: 3, method: 4, reference: 5, name: 6 };
    body = table;
    if (!parseImportDate(header[0] ?? "", timeZone)) {
      return { rows: [], error: "Could not find the columns. Expected a header with date, phone and amount." };
    }
  }
  const col = (row: string[], key: string) => (columns![key] === undefined ? "" : (row[columns![key]!] ?? ""));
  const rows: ParsedImportRow[] = [];
  body.slice(0, MAX_IMPORT_ROWS).forEach((row, i) => {
    const problems: string[] = [];
    const dateText = col(row, "date");
    const phoneText = col(row, "phone");
    const amountText = col(row, "amount");
    const paidAt = parseImportDate(dateText, timeZone);
    if (!paidAt) problems.push("Unreadable date");
    else if (paidAt.getTime() > Date.now() + 86_400_000) problems.push("Date is in the future");
    const phone = normalisePhone(phoneText);
    if (!phone) problems.push("Unreadable phone number");
    const amount = parseAmount(amountText);
    if (amount === null || amount === 0) problems.push("Unreadable or zero amount");
    else if (amount > MAX_AMOUNT) problems.push("Amount is implausibly large");
    const reference = col(row, "reference").slice(0, 120) || null;
    const name = col(row, "name").slice(0, 120) || null;
    rows.push({
      line: hasHeader ? i + 2 : i + 1,
      paidAt,
      dateText,
      phone,
      phoneText,
      amount,
      kind: parseKind(col(row, "kind")),
      method: parseMethod(col(row, "method")),
      reference,
      name,
      problems,
    });
  });
  return { rows, error: body.length > MAX_IMPORT_ROWS ? `Only the first ${MAX_IMPORT_ROWS} rows were read.` : null };
}

// ── Preview & confirm ────────────────────────────────────────────────────────

export const ImportPreviewInput = z.object({ csv: z.string().min(1, "Paste or upload a CSV").max(MAX_CSV_BYTES, "The file is too large (1 MB max)") });

export interface ImportPreviewRow {
  line: number;
  paidAt: string | null;
  dateText: string;
  phone: string | null;
  phoneText: string;
  amount: number | null;
  kind: PaymentKindValue;
  kindLabel: string;
  method: PaymentMethodValue;
  methodLabel: string;
  reference: string | null;
  name: string | null;
  patient: { id: string; fullName: string } | null;
  problems: string[];
  ok: boolean;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  summary: { total: number; ready: number; unmatched: number; invalid: number; amount: number };
  error: string | null;
}

export async function previewImport(tenantId: string, rawInput: unknown): Promise<ImportPreview> {
  const input = ImportPreviewInput.parse(rawInput);
  const timeZone = await getTenantTimezone(tenantId);
  const parsed = parseImportRows(input.csv, timeZone);

  const phones = [...new Set(parsed.rows.map((r) => r.phone).filter((p): p is string => Boolean(p)))];
  const variants = phones.flatMap(phoneVariants);
  const patients = variants.length
    ? await db.patient.findMany({
        where: { tenantId, ...notDeleted, OR: [{ phone: { in: variants } }, { whatsapp: { in: variants } }] },
        select: { id: true, fullName: true, phone: true, whatsapp: true },
        take: 5000,
      })
    : [];
  const byPhone = new Map<string, { id: string; fullName: string }>();
  for (const p of patients) {
    for (const raw of [p.phone, p.whatsapp]) {
      const n = raw ? normalisePhone(raw) : null;
      if (n && !byPhone.has(n)) byPhone.set(n, { id: p.id, fullName: p.fullName });
    }
  }

  const references = [...new Set(parsed.rows.map((r) => r.reference).filter((r): r is string => Boolean(r)))];
  const existing = references.length
    ? await db.payment.findMany({ where: { tenantId, ...notDeleted, reference: { in: references } }, select: { reference: true } })
    : [];
  const known = new Set(existing.map((e) => e.reference));
  const seenInFile = new Set<string>();

  const rows: ImportPreviewRow[] = parsed.rows.map((r) => {
    const problems = [...r.problems];
    const patient = r.phone ? (byPhone.get(r.phone) ?? null) : null;
    if (r.phone && !patient) problems.push("No patient with this phone number");
    if (r.reference) {
      if (known.has(r.reference)) problems.push("A payment with this reference already exists");
      else if (seenInFile.has(r.reference)) problems.push("Duplicate reference inside the file");
      seenInFile.add(r.reference);
    }
    return {
      line: r.line,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      dateText: r.dateText,
      phone: r.phone,
      phoneText: r.phoneText,
      amount: r.amount,
      kind: r.kind,
      kindLabel: KIND_LABELS[r.kind],
      method: r.method,
      methodLabel: METHOD_LABELS[r.method],
      reference: r.reference,
      name: r.name,
      patient,
      problems,
      ok: problems.length === 0 && patient !== null,
    };
  });
  const ready = rows.filter((r) => r.ok);
  return {
    rows,
    summary: {
      total: rows.length,
      ready: ready.length,
      unmatched: rows.filter((r) => r.patient === null && r.phone !== null).length,
      invalid: rows.filter((r) => r.problems.some((p) => !p.startsWith("No patient"))).length,
      amount: ready.reduce((s, r) => s + (r.amount ?? 0), 0),
    },
    error: parsed.error,
  };
}

const zId = zText(64).min(1);

export const ImportConfirmInput = z.object({
  rows: z
    .array(
      z.object({
        patientId: zId,
        paidAt: zDateTime,
        amount: z.number().int().positive().max(MAX_AMOUNT),
        kind: z.enum(PAYMENT_KINDS),
        method: z.enum(PAYMENT_METHODS).default("POS"),
        reference: zOptionalText(120),
        note: zOptionalText(500),
      }),
    )
    .min(1, "Nothing to import")
    .max(MAX_IMPORT_ROWS),
});
export type ImportConfirmInput = z.infer<typeof ImportConfirmInput>;

/** Create the confirmed rows as payments under one batch id. All or nothing. */
export async function confirmImport(tenantId: string, rawInput: unknown, actor: Actor = {}) {
  const input = ImportConfirmInput.parse(rawInput);
  const patientIds = [...new Set(input.rows.map((r) => r.patientId))];
  const patients = await db.patient.findMany({ where: { tenantId, ...notDeleted, id: { in: patientIds } }, select: { id: true } });
  const allowed = new Set(patients.map((p) => p.id));
  for (const id of patientIds) if (!allowed.has(id)) throw new TenantScopeError("patient", id);

  const importBatchId = randomUUID();
  const now = new Date();
  const created = await db.$transaction(async (tx) => {
    const data = input.rows.map((r) => ({
      tenantId,
      patientId: r.patientId,
      kind: r.kind,
      method: r.method,
      amount: r.amount,
      paidAt: r.paidAt,
      reference: r.reference ?? null,
      note: r.note ?? null,
      importBatchId,
      createdById: actor.id ?? null,
      createdAt: now,
    }));
    const result = await tx.payment.createMany({ data });
    const rows = await tx.payment.findMany({ where: { tenantId, importBatchId }, select: { id: true, patientId: true, kind: true, amount: true, method: true, paidAt: true, reference: true } });
    await tx.timelineEvent.createMany({
      data: rows.map((p) => ({
        tenantId,
        patientId: p.patientId,
        kind: "PAYMENT" as const,
        title: `${KIND_LABELS[p.kind]} — ${p.amount.toLocaleString("en-US")} EGP (${METHOD_LABELS[p.method].toLowerCase()})`,
        body: `POS import${p.reference ? ` · Ref ${p.reference}` : ""}`,
        refId: p.id,
        occurredAt: p.paidAt,
      })),
    });
    return result.count;
  });

  await audit({
    tenantId,
    actorId: actor.id,
    actorEmail: actor.email,
    ip: actor.ip,
    action: "payment.import",
    entity: "PaymentImport",
    entityId: importBatchId,
    after: { count: created, amount: input.rows.reduce((s, r) => s + r.amount, 0), patients: patientIds.length },
  });
  return { importBatchId, created };
}

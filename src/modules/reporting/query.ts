import { z } from "zod";
import { zOptionalText } from "@/lib/validation";
import { PERIOD_PRESETS, resolvePeriod, type ResolvedPeriod } from "./period";

/**
 * Query-string parsing shared by the finance and report endpoints and pages:
 * the period (`period`, `from`, `to`) and the report filters.
 */
export const LEAD_SOURCES = ["CLICK_TO_WHATSAPP_AD", "INSTAGRAM_ORGANIC", "WEBSITE", "REFERRAL", "WALK_IN", "PHONE", "OTHER"] as const;
export type LeadSourceValue = (typeof LEAD_SOURCES)[number];

export const SOURCE_LABELS: Record<LeadSourceValue | "unknown", string> = {
  CLICK_TO_WHATSAPP_AD: "Click-to-WhatsApp ad",
  INSTAGRAM_ORGANIC: "Instagram (organic)",
  WEBSITE: "Website",
  REFERRAL: "Referral",
  WALK_IN: "Walk-in",
  PHONE: "Phone",
  OTHER: "Other",
  unknown: "Unknown",
};

const zDateKey = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const ReportQuery = z.object({
  period: z.enum(PERIOD_PRESETS).optional(),
  from: zDateKey.optional(),
  to: zDateKey.optional(),
  doctorId: zOptionalText(64),
  treatment: zOptionalText(64),
  source: z.enum(LEAD_SOURCES).optional(),
  tab: zOptionalText(40),
});
export type ReportQuery = z.infer<typeof ReportQuery>;

export interface ReportFilters {
  doctorId?: string;
  treatmentKey?: string;
  source?: LeadSourceValue;
}

/** Tolerant parse: an unknown value is dropped rather than failing the page. */
export function parseReportQuery(raw: Record<string, string | string[] | undefined>): ReportQuery {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) flat[k] = Array.isArray(v) ? v[0] : v;
  const parsed = ReportQuery.safeParse(flat);
  if (parsed.success) return parsed.data;
  const out: Record<string, string | undefined> = { ...flat };
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string") delete out[key];
  }
  const retry = ReportQuery.safeParse(out);
  return retry.success ? retry.data : {};
}

/** `?from&to` without `period` means a custom range. */
export function periodFromSearchParams(params: URLSearchParams, timeZone: string, now: Date = new Date()): ResolvedPeriod {
  const q = parseReportQuery(Object.fromEntries(params));
  const preset = q.period ?? (q.from && q.to ? "custom" : undefined);
  return resolvePeriod({ period: preset, from: q.from, to: q.to }, timeZone, now);
}

export function periodFromQuery(q: ReportQuery, timeZone: string, now: Date = new Date()): ResolvedPeriod {
  const preset = q.period ?? (q.from && q.to ? "custom" : undefined);
  return resolvePeriod({ period: preset, from: q.from, to: q.to }, timeZone, now);
}

export function filtersFromQuery(q: ReportQuery): ReportFilters {
  return {
    ...(q.doctorId ? { doctorId: q.doctorId } : {}),
    ...(q.treatment ? { treatmentKey: q.treatment } : {}),
    ...(q.source ? { source: q.source } : {}),
  };
}

/** The query entries (period + filters) to carry on links and export URLs. */
export function queryEntries(q: ReportQuery, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const merged: Record<string, string | undefined> = { period: q.period, from: q.from, to: q.to, doctorId: q.doctorId, treatment: q.treatment, source: q.source, tab: q.tab, ...overrides };
  for (const [k, v] of Object.entries(merged)) if (v) out[k] = v;
  return out;
}

export function toSearch(entries: Record<string, string>): string {
  const params = new URLSearchParams(entries);
  const s = params.toString();
  return s ? `?${s}` : "";
}

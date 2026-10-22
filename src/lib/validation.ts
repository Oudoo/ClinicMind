import { z } from "zod";

/**
 * Shared Zod helpers for request bodies.
 */

/** Accepts `YYYY-MM-DD` or a full ISO timestamp; yields a Date at UTC midnight for date-only input. */
export const zDate = z
  .string()
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isNaN(Date.parse(s)), "Invalid date")
  .transform((s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00.000Z`) : new Date(s)));

/** ISO timestamp → Date. */
export const zDateTime = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(Date.parse(s)), "Invalid date/time")
  .transform((s) => new Date(s));

/** Trimmed string with a hard upper bound (storage and abuse protection). */
export const zText = (max: number) => z.string().trim().max(max);

/** Optional trimmed string; blank becomes undefined. */
export const zOptionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), zText(max).optional());

/** E.164-ish phone: digits with optional leading +, 7–20 chars. */
export const zPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, "Invalid phone number")
  .transform((s) => s.replace(/[ ()-]/g, ""));

/** Page / pageSize query parsing with sane bounds. */
export function parsePaging(params: URLSearchParams, defaults = { pageSize: 25, maxPageSize: 100 }) {
  const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    defaults.maxPageSize,
    Math.max(1, Number.parseInt(params.get("pageSize") ?? String(defaults.pageSize), 10) || defaults.pageSize),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

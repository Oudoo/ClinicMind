import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind-aware className combiner. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Locale-aware date formatting used across the clinical UI. */
export function formatDate(date: Date | string, locale = "en-GB") {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(d);
}

/**
 * A calendar date with no time of day (a date of birth): stored as midnight
 * UTC, so it is formatted in UTC and shows the same day in every time zone.
 */
export function formatCalendarDate(date: Date | string, locale = "en-GB") {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function formatTime(date: Date | string, locale = "en-GB") {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
}

export function formatNumber(n: number, locale = "en-US") {
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * Completed years since a date of birth (stored as midnight UTC), counted on
 * the calendar so the age changes on the birthday itself. Null for a missing,
 * invalid or future date, so no screen ever shows a negative age.
 */
export function ageFrom(dob?: Date | string | null, now: Date = new Date()): number | null {
  if (!dob) return null;
  const d = typeof dob === "string" ? new Date(dob) : dob;
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

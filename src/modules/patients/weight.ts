import { formatDateInTz } from "@/lib/time";

/**
 * The patient's last weight, and how long it counts for the dose checks: 180
 * days. Older, the per-kilogram checks treat the weight as not known.
 */
export const WEIGHT_HOLDS_DAYS = 180;

const DAY_MS = 86_400_000;

export interface WeightRecord {
  weightKg: number | null;
  weighedAt: Date | null;
}

/** The weight in kg, or null when none is recorded or it is too old to count. */
export function weightKnown(p: WeightRecord, now: Date = new Date()): number | null {
  if (p.weightKg === null || !p.weighedAt) return null;
  return now.getTime() - p.weighedAt.getTime() <= WEIGHT_HOLDS_DAYS * DAY_MS ? p.weightKg : null;
}

/** "Weight 58 kg (24 Oct 2026)", "Weight 58 kg on 2 Jan 2026, too long ago to count", "Weight not recorded". */
export function weightLine(p: WeightRecord, timezone: string, now: Date = new Date()): string {
  if (p.weightKg === null || !p.weighedAt) return "Weight not recorded";
  const on = formatDateInTz(p.weighedAt, timezone, { day: "numeric", month: "short", year: "numeric" });
  const kg = Number.isInteger(p.weightKg) ? String(p.weightKg) : p.weightKg.toFixed(1);
  return weightKnown(p, now) === null ? `Weight ${kg} kg on ${on}, too long ago to count` : `Weight ${kg} kg (${on})`;
}

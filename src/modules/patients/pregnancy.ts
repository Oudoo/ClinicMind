import type { PregnancyStatus } from "@prisma/client";
import { formatDateInTz } from "@/lib/time";

/**
 * The patient's recorded pregnancy status, and how long it counts: a
 * pregnancy excluded (a test, or the patient's word) counts for 30 days, a
 * recorded pregnancy for 300. Older than that it is unknown again, and the
 * safety checks ask for a reason as they do when nothing is recorded.
 */
export const PREGNANCY_EXCLUDED_DAYS = 30;
export const PREGNANCY_HOLDS_DAYS = 300;

const DAY_MS = 86_400_000;

export interface PregnancyRecord {
  pregnancyStatus: PregnancyStatus | null;
  pregnancyCheckedAt: Date | null;
}

/** true: pregnant · false: pregnancy excluded recently · null: not known. */
export function pregnancyKnown(p: PregnancyRecord, now: Date = new Date()): boolean | null {
  if (!p.pregnancyStatus || !p.pregnancyCheckedAt) return null;
  const age = now.getTime() - p.pregnancyCheckedAt.getTime();
  if (p.pregnancyStatus === "PREGNANT") return age <= PREGNANCY_HOLDS_DAYS * DAY_MS ? true : null;
  return age <= PREGNANCY_EXCLUDED_DAYS * DAY_MS ? false : null;
}

/** "Pregnancy excluded on 3 Oct 2026", "Pregnant (recorded 1 Sept 2026)", "Pregnancy not recorded". */
export function pregnancyLine(p: PregnancyRecord, timezone: string, now: Date = new Date()): string {
  if (!p.pregnancyStatus || !p.pregnancyCheckedAt) return "Pregnancy not recorded";
  const on = formatDateInTz(p.pregnancyCheckedAt, timezone, { day: "numeric", month: "short", year: "numeric" });
  const known = pregnancyKnown(p, now);
  if (p.pregnancyStatus === "PREGNANT") return known ? `Pregnant (recorded ${on})` : `Pregnancy recorded ${on}, too long ago to count`;
  return known === false ? `Pregnancy excluded on ${on}` : `Pregnancy excluded on ${on}, more than ${PREGNANCY_EXCLUDED_DAYS} days ago: not known now`;
}

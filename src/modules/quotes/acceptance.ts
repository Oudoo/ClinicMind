import { db } from "@/lib/db";
import { addDays, startOfDayInTz } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { quoteTotals } from "./constants";
import type { AcceptanceRow, CaseAcceptance } from "./dto";

/**
 * Case acceptance: of the treatment plans given to patients in a period, how
 * many were accepted and how much of their value (a plan accepted in part
 * counts in part), how many were declined, expired or are still waiting —
 * overall, by doctor and by treatment. A plan withdrawn by the clinic, or
 * replaced by a revision, is left out: the revision counts instead.
 */

export const ACCEPTANCE_PERIODS = [30, 90, 365] as const;

export const emptyAcceptance = (): AcceptanceRow => ({ presented: 0, presentedValue: 0, accepted: 0, acceptedValue: 0, declined: 0, expired: 0, open: 0 });

/** One plan given, counted into a row: accepted (in part counts in part), declined, past its last day while still waiting (expired), or open. */
export function tallyQuote(row: AcceptanceRow, q: { status: string; total: number; acceptedTotal: number | null; validUntil: Date }, today: Date): void {
  row.presented += 1;
  row.presentedValue += q.total;
  if (q.status === "ACCEPTED") {
    row.accepted += 1;
    row.acceptedValue += q.acceptedTotal ?? 0;
  } else if (q.status === "DECLINED") row.declined += 1;
  else if (q.validUntil.getTime() < today.getTime()) row.expired += 1;
  else row.open += 1;
}

export async function caseAcceptance(tenantId: string, opts: { days?: number; byDoctor?: boolean; now?: Date } = {}): Promise<CaseAcceptance> {
  const days = opts.days && opts.days > 0 ? Math.min(opts.days, 730) : 90;
  const now = opts.now ?? new Date();
  const timezone = await getTenantTimezone(tenantId);
  const today = startOfDayInTz(now, timezone);
  const from = addDays(today, -(days - 1), timezone);
  const weekOut = addDays(today, 7, timezone);
  const [quotes, open] = await Promise.all([
    db.quote.findMany({
      where: { tenantId, status: { in: ["SENT", "ACCEPTED", "DECLINED"] }, sentAt: { gte: from } },
      select: {
        status: true,
        total: true,
        acceptedTotal: true,
        validUntil: true,
        doctorId: true,
        items: { select: { treatmentId: true, price: true, discount: true, accepted: true, treatment: { select: { name: true } } } },
      },
    }),
    db.quote.findMany({ where: { tenantId, status: "SENT", validUntil: { gte: today, lte: weekOut } }, select: { total: true } }),
  ]);

  const overall = emptyAcceptance();
  const doctors = new Map<string | null, AcceptanceRow>();
  const treatments = new Map<string, { treatmentId: string; name: string; presentedValue: number; acceptedValue: number; presented: number; accepted: number }>();
  for (const q of quotes) {
    const rows = [overall];
    if (opts.byDoctor) {
      const row = doctors.get(q.doctorId) ?? emptyAcceptance();
      doctors.set(q.doctorId, row);
      rows.push(row);
    }
    for (const row of rows) tallyQuote(row, q, today);
    for (const item of q.items) {
      const t = treatments.get(item.treatmentId) ?? { treatmentId: item.treatmentId, name: item.treatment.name, presentedValue: 0, acceptedValue: 0, presented: 0, accepted: 0 };
      treatments.set(item.treatmentId, t);
      const net = quoteTotals([item]).total;
      t.presented += 1;
      t.presentedValue += net;
      if (item.accepted) {
        t.accepted += 1;
        t.acceptedValue += net;
      }
    }
  }

  let byDoctor: CaseAcceptance["byDoctor"] = null;
  if (opts.byDoctor) {
    const ids = [...doctors.keys()].filter((d): d is string => Boolean(d));
    const users = ids.length ? await db.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, fullName: true, email: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
    byDoctor = [...doctors.entries()]
      .map(([doctorId, row]) => ({ ...row, doctorId, name: doctorId ? (names.get(doctorId) ?? "A former doctor") : "No doctor named" }))
      .sort((a, b) => b.presentedValue - a.presentedValue || a.name.localeCompare(b.name));
  }

  return {
    ...overall,
    days,
    from: from.toISOString(),
    expiringSoon: { count: open.length, value: open.reduce((s, q) => s + q.total, 0) },
    byDoctor,
    byTreatment: [...treatments.values()].sort((a, b) => b.presentedValue - a.presentedValue || a.name.localeCompare(b.name)),
  };
}

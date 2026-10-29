import type { Prisma, RecallKind } from "@prisma/client";
import { db } from "@/lib/db";
import type { Period } from "@/modules/reporting/period";
import { declineReasonLabel, RECALL_KIND_LABEL, RECALL_KINDS, WAITING_RECALL_STATUSES } from "./constants";

/**
 * The recall dashboard (Recalls → Results), for a period on the clinic clock
 * and the one before it:
 *  - the recalls due in the period: how many, contacted (a call or a WhatsApp
 *    message, by the desk or automatic), booked (a visit booked for it, or the
 *    patient came back), booked within 30 days of the due day; by kind;
 *  - accepted treatment not booked: planned work and a course's next
 *    sessions still waiting, and what they are worth;
 *  - lapsed patients won back (a year without a visit, then came back);
 *  - revenue from recalls: the work charged at the visits that ended a recall
 *    as done, and their consultation fees (the roles that see finance);
 *  - how the recalls ended in the period (came back, declined and why,
 *    unreachable), and each person's part: calls, messages, visits booked,
 *    declines and unreachables recorded.
 */

const DAY_MS = 86_400_000;
/** "Booked within 30 days": booked (or seen) no later than 30 days after the due day. */
export const BOOKED_WITHIN_DAYS = 30;

export interface DueStats {
  count: number;
  contacted: number;
  booked: number;
  bookedInTime: number;
}

export interface RecallResultsDTO {
  due: DueStats;
  previousDue: DueStats;
  byKind: { kind: RecallKind; label: string; due: number; contacted: number; booked: number }[];
  /** Waiting now: planned work not booked and a course's next sessions. */
  notBooked: { planned: number; sessions: number; value: number };
  lapsed: { wonBack: number; previousWonBack: number; waiting: number };
  /** Null for the roles that do not see finance. */
  revenue: { current: number; previous: number; visits: number } | null;
  ended: { done: number; declined: number; unreachable: number; endedAutomatically: number; reasons: { key: string; label: string; count: number }[] };
  byPerson: { id: string | null; name: string; calls: number; messages: number; booked: number; declined: number; unreachable: number }[];
}

const between = (p: Period) => ({ gte: p.from, lt: p.to });

async function dueIn(tenantId: string, period: Period) {
  const rows = await db.recall.findMany({
    where: { tenantId, dueAt: between(period) },
    select: { kind: true, status: true, dueAt: true, bookedAt: true, closedAt: true, _count: { select: { activities: { where: { kind: { in: ["CALL", "MESSAGE"] } } } } } },
  });
  return rows.map((r) => {
    const seenAt = r.bookedAt ?? (r.status === "DONE" ? r.closedAt : null);
    return {
      kind: r.kind,
      contacted: r._count.activities > 0,
      booked: seenAt !== null,
      bookedInTime: seenAt !== null && seenAt.getTime() <= r.dueAt.getTime() + BOOKED_WITHIN_DAYS * DAY_MS,
    };
  });
}

function stats(rows: Awaited<ReturnType<typeof dueIn>>): DueStats {
  return {
    count: rows.length,
    contacted: rows.filter((r) => r.contacted).length,
    booked: rows.filter((r) => r.booked).length,
    bookedInTime: rows.filter((r) => r.bookedInTime).length,
  };
}

/** The work charged at the visits that ended recalls as done in the period (a session marked done without a visit: its charge), and their consultation fees. */
async function revenueOf(tenantId: string, period: Period): Promise<{ amount: number; visits: number }> {
  const done = await db.recall.findMany({ where: { tenantId, status: "DONE", closedAt: between(period) }, select: { doneAppointmentId: true, procedureId: true, stage: true } });
  const visits = [...new Set(done.map((r) => r.doneAppointmentId).filter((id): id is string => Boolean(id)))];
  const sessions = done.filter((r) => !r.doneAppointmentId && r.procedureId && r.stage).map((r) => ({ procedureId: r.procedureId!, stage: r.stage! }));
  const atVisits: Prisma.ChargeWhereInput[] = visits.length ? [{ appointmentId: { in: visits } }, { appointmentId: null, procedure: { appointmentId: { in: visits } } }] : [];
  const [charged, fees] = await Promise.all([
    atVisits.length || sessions.length ? db.charge.aggregate({ where: { tenantId, OR: [...atVisits, ...sessions] }, _sum: { amount: true } }) : null,
    visits.length ? db.payment.aggregate({ where: { tenantId, kind: "CONSULTATION_FEE", appointmentId: { in: visits }, deletedAt: null }, _sum: { amount: true } }) : null,
  ]);
  return { amount: (charged?._sum.amount ?? 0) + (fees?._sum.amount ?? 0), visits: visits.length + sessions.length };
}

export async function recallResults(tenantId: string, period: Period & { previous: Period }, opts: { withRevenue: boolean }): Promise<RecallResultsDTO> {
  const waiting = { in: [...WAITING_RECALL_STATUSES] };
  const [current, previous, notBooked, wonBack, previousWonBack, lapsedWaiting, revenue, previousRevenue, endings, activity, bookings] = await Promise.all([
    dueIn(tenantId, period),
    dueIn(tenantId, period.previous),
    db.recall.groupBy({ by: ["kind"], where: { tenantId, status: waiting, kind: { in: ["UNBOOKED", "NEXT_SESSION"] } }, _count: { _all: true }, _sum: { value: true } }),
    db.recall.count({ where: { tenantId, kind: "LAPSED", status: "DONE", closedAt: between(period) } }),
    db.recall.count({ where: { tenantId, kind: "LAPSED", status: "DONE", closedAt: between(period.previous) } }),
    db.recall.count({ where: { tenantId, kind: "LAPSED", status: waiting } }),
    opts.withRevenue ? revenueOf(tenantId, period) : null,
    opts.withRevenue ? revenueOf(tenantId, period.previous) : null,
    db.recall.groupBy({ by: ["status", "declineReason", "closedById"], where: { tenantId, status: { in: ["DONE", "DECLINED", "UNREACHABLE"] }, closedAt: between(period) }, _count: { _all: true } }),
    db.recallActivity.groupBy({ by: ["byId", "kind"], where: { tenantId, kind: { in: ["CALL", "MESSAGE"] }, at: between(period) }, _count: { _all: true } }),
    db.recall.groupBy({ by: ["bookedById"], where: { tenantId, bookedAt: between(period), bookedById: { not: null } }, _count: { _all: true } }),
  ]);

  const byKind = RECALL_KINDS.map((kind) => {
    const rows = current.filter((r) => r.kind === kind);
    return { kind, label: RECALL_KIND_LABEL[kind], due: rows.length, contacted: rows.filter((r) => r.contacted).length, booked: rows.filter((r) => r.booked).length };
  }).filter((k) => k.due > 0);

  const sumEnded = (status: string) => endings.filter((e) => e.status === status).reduce((s, e) => s + e._count._all, 0);
  const reasons = new Map<string, number>();
  for (const e of endings) if (e.status === "DECLINED") reasons.set(e.declineReason ?? "other", (reasons.get(e.declineReason ?? "other") ?? 0) + e._count._all);

  // Each person's part; the automatic messages and the endings no one recorded are "Automatically".
  type Part = RecallResultsDTO["byPerson"][number];
  const parts = new Map<string | null, Omit<Part, "name">>();
  const part = (id: string | null) => {
    let p = parts.get(id);
    if (!p) parts.set(id, (p = { id, calls: 0, messages: 0, booked: 0, declined: 0, unreachable: 0 }));
    return p;
  };
  for (const a of activity) {
    if (a.kind === "CALL") part(a.byId).calls += a._count._all;
    else part(a.byId).messages += a._count._all;
  }
  for (const b of bookings) part(b.bookedById).booked += b._count._all;
  for (const e of endings) {
    if (e.status === "DECLINED") part(e.closedById).declined += e._count._all;
    if (e.status === "UNREACHABLE") part(e.closedById).unreachable += e._count._all;
  }
  const ids = [...parts.keys()].filter((id): id is string => Boolean(id));
  const users = ids.length ? await db.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, fullName: true, email: true } }) : [];
  const name = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  const byPerson = [...parts.values()]
    .map((p) => ({ ...p, name: p.id ? (name.get(p.id) ?? "Former staff member") : "Automatically" }))
    .sort((a, b) => Number(a.id === null) - Number(b.id === null) || b.booked - a.booked || b.calls + b.messages - (a.calls + a.messages) || a.name.localeCompare(b.name));

  return {
    due: stats(current),
    previousDue: stats(previous),
    byKind,
    notBooked: {
      planned: notBooked.find((n) => n.kind === "UNBOOKED")?._count._all ?? 0,
      sessions: notBooked.find((n) => n.kind === "NEXT_SESSION")?._count._all ?? 0,
      value: notBooked.reduce((s, n) => s + (n._sum.value ?? 0), 0),
    },
    lapsed: { wonBack, previousWonBack, waiting: lapsedWaiting },
    revenue: revenue && previousRevenue ? { current: revenue.amount, previous: previousRevenue.amount, visits: revenue.visits } : null,
    ended: {
      done: sumEnded("DONE"),
      declined: sumEnded("DECLINED"),
      unreachable: sumEnded("UNREACHABLE"),
      endedAutomatically: endings.filter((e) => e.status === "UNREACHABLE" && e.closedById === null).reduce((s, e) => s + e._count._all, 0),
      reasons: [...reasons.entries()].map(([key, count]) => ({ key, label: declineReasonLabel(key), count })).sort((a, b) => b.count - a.count),
    },
    byPerson,
  };
}

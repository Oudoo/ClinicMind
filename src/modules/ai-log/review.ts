import { db } from "@/lib/db";
import { readTenantSetting, updateTenantSettings } from "@/lib/tenant-settings";
import { zonedParts, zonedTimeToUtc } from "@/lib/time";
import { getTenantTimezone } from "@/modules/appointments/service";
import { ruleLabel } from "@/modules/consultations/safety/labels";
import { notify } from "@/modules/notifications/service";
import { QUESTION_KIND_LABEL, QUESTION_KINDS, REVIEW_HOUR, type QuestionKind } from "./constants";

/**
 * The owner's monthly review of the clinic's AI (Phase 4, log and review):
 * the questions asked of the evidence panel and the assistant in a month,
 * answered from sources or records or not, how the doctors rated the
 * answers (and what they said about the poor ones), the questions nothing
 * answered (sources the library may need), the sources cited most, what was
 * taken to OpenEvidence, and the prescribing-safety overrides. On the first of
 * each month the clinician owners are told last month's review is ready.
 */

export interface MonthOption {
  key: string;
  label: string;
}

export interface ReviewQuestion {
  runId: string;
  at: string;
  by: string;
  kind: QuestionKind;
  kindLabel: string;
  question: string;
}

export interface MonthlyReviewDTO {
  month: string;
  label: string;
  months: MonthOption[];
  questions: { total: number; evidence: number; assistant: number; answered: number; unanswered: number; failed: number; external: number; previousTotal: number };
  ratings: { rated: number; helpful: number; notHelpful: number };
  byDoctor: { name: string; questions: number; answered: number; helpful: number; notHelpful: number }[];
  notHelpful: (ReviewQuestion & { answer: string; comment: string | null; sources: string[] })[];
  unanswered: ReviewQuestion[];
  sources: { title: string; cited: number }[];
  overrides: { total: number; stops: number; warnings: number; byRule: { label: string; count: number }[] };
}

const pad = (n: number) => String(n).padStart(2, "0");
const monthLabel = (year: number, month: number) => new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));

function parseMonth(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month >= 1 && month <= 12 && year >= 2000 && year <= 2100 ? { year, month } : null;
}

const shift = ({ year, month }: { year: number; month: number }, by: number) => {
  const index = year * 12 + (month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

/** "2026-10" of an instant on the clinic's clock. */
export function monthKeyOf(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}`;
}

export function previousMonthKey(key: string): string {
  const prev = shift(parseMonth(key)!, -1);
  return `${prev.year}-${pad(prev.month)}`;
}

/** The month's first instant and the next month's, on the clinic's clock. */
export function monthBounds(key: string, timeZone: string): { from: Date; to: Date; label: string } | null {
  const m = parseMonth(key);
  if (!m) return null;
  const next = shift(m, 1);
  return {
    from: zonedTimeToUtc({ year: m.year, month: m.month, day: 1, hour: 0, minute: 0 }, timeZone),
    to: zonedTimeToUtc({ year: next.year, month: next.month, day: 1, hour: 0, minute: 0 }, timeZone),
    label: monthLabel(m.year, m.month),
  };
}

/** This month and the eleven before it, newest first. */
export function recentMonths(now: Date, timeZone: string, count = 12): MonthOption[] {
  const current = parseMonth(monthKeyOf(now, timeZone))!;
  return Array.from({ length: count }, (_, i) => {
    const m = shift(current, -i);
    return { key: `${m.year}-${pad(m.month)}`, label: monthLabel(m.year, m.month) };
  });
}

const titlesOf = (citations: unknown): string[] =>
  Array.isArray(citations)
    ? citations.map((c) => (c && typeof c === "object" && typeof (c as { title?: unknown }).title === "string" ? (c as { title: string }).title : null)).filter((t): t is string => Boolean(t))
    : [];

/** The question as asked (the assistant) or as it was sent (the evidence panel: without the patient's name). */
function questionOf(kind: string, rawPrompt: string, context: unknown): string {
  if (kind === "evidence") {
    const sent = context && typeof context === "object" ? (context as { question?: unknown }).question : null;
    if (typeof sent === "string") return sent;
    const at = rawPrompt.lastIndexOf("Question: ");
    return at === -1 ? rawPrompt : rawPrompt.slice(at + "Question: ".length);
  }
  return rawPrompt;
}

export async function monthlyReview(tenantId: string, monthKey: string | undefined, now: Date = new Date()): Promise<MonthlyReviewDTO> {
  const timeZone = await getTenantTimezone(tenantId);
  const key = monthKey && parseMonth(monthKey) ? monthKey : monthKeyOf(now, timeZone);
  const { from, to, label } = monthBounds(key, timeZone)!;
  const previous = monthBounds(previousMonthKey(key), timeZone)!;
  const kinds = [...QUESTION_KINDS];

  const [runs, previousTotal, external, overrides, users] = await Promise.all([
    db.aiRun.findMany({
      where: { tenantId, kind: { in: kinds }, createdAt: { gte: from, lt: to } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        authorId: true,
        rawPrompt: true,
        retrievedContext: true,
        generatedOutput: true,
        citations: true,
        status: true,
        createdAt: true,
        // The asker's latest rating counts.
        feedback: { orderBy: { createdAt: "desc" }, take: 1, select: { helpful: true, comment: true } },
      },
    }),
    db.aiRun.count({ where: { tenantId, kind: { in: kinds }, createdAt: { gte: previous.from, lt: previous.to } } }),
    db.auditLog.count({ where: { tenantId, action: "evidence.openevidence", createdAt: { gte: from, lt: to } } }),
    db.safetyOverride.findMany({ where: { tenantId, createdAt: { gte: from, lt: to } }, select: { rule: true, severity: true } }),
    db.user.findMany({ where: { tenantId }, select: { id: true, fullName: true, email: true } }),
  ]);
  const nameOf = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));

  const rows = runs.map((r) => {
    const kind = r.kind as QuestionKind;
    const answered = r.status === "SUCCEEDED" && Array.isArray(r.citations) && r.citations.length > 0;
    return {
      base: { runId: r.id, at: r.createdAt.toISOString(), by: (r.authorId && nameOf.get(r.authorId)) || "Former staff member", kind, kindLabel: QUESTION_KIND_LABEL[kind], question: questionOf(r.kind, r.rawPrompt, r.retrievedContext) },
      authorId: r.authorId ?? "",
      answered,
      failed: r.status === "FAILED",
      rating: r.feedback[0] ?? null,
      answer: r.generatedOutput ?? "",
      sources: r.kind === "evidence" ? [...new Set(titlesOf(r.citations))] : [],
    };
  });

  const doctors = new Map<string, MonthlyReviewDTO["byDoctor"][number]>();
  for (const r of rows) {
    const d = doctors.get(r.authorId) ?? { name: r.base.by, questions: 0, answered: 0, helpful: 0, notHelpful: 0 };
    d.questions += 1;
    if (r.answered) d.answered += 1;
    if (r.rating?.helpful === true) d.helpful += 1;
    if (r.rating?.helpful === false) d.notHelpful += 1;
    doctors.set(r.authorId, d);
  }

  const cited = new Map<string, number>();
  for (const r of runs.filter((run) => run.kind === "evidence")) for (const title of new Set(titlesOf(r.citations))) cited.set(title, (cited.get(title) ?? 0) + 1);

  const byRule = new Map<string, number>();
  for (const o of overrides) byRule.set(ruleLabel(o.rule), (byRule.get(ruleLabel(o.rule)) ?? 0) + 1);

  return {
    month: key,
    label,
    months: recentMonths(now, timeZone),
    questions: {
      total: rows.length,
      evidence: rows.filter((r) => r.base.kind === "evidence").length,
      assistant: rows.filter((r) => r.base.kind !== "evidence").length,
      answered: rows.filter((r) => r.answered).length,
      unanswered: rows.filter((r) => !r.answered && !r.failed).length,
      failed: rows.filter((r) => r.failed).length,
      external,
      previousTotal,
    },
    ratings: {
      rated: rows.filter((r) => r.rating).length,
      helpful: rows.filter((r) => r.rating?.helpful === true).length,
      notHelpful: rows.filter((r) => r.rating?.helpful === false).length,
    },
    byDoctor: [...doctors.values()].sort((a, b) => b.questions - a.questions || a.name.localeCompare(b.name)),
    notHelpful: rows
      .filter((r) => r.rating?.helpful === false)
      .map((r) => ({ ...r.base, answer: r.answer.length > 400 ? `${r.answer.slice(0, 399)}…` : r.answer, comment: r.rating?.comment ?? null, sources: r.sources })),
    unanswered: rows.filter((r) => !r.answered && !r.failed).slice(0, 25).map((r) => r.base),
    sources: [...cited].map(([title, n]) => ({ title, cited: n })).sort((a, b) => b.cited - a.cited || a.title.localeCompare(b.title)).slice(0, 10),
    overrides: {
      total: overrides.length,
      stops: overrides.filter((o) => o.severity === "stop").length,
      warnings: overrides.filter((o) => o.severity !== "stop").length,
      byRule: [...byRule].map(([l, count]) => ({ label: l, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    },
  };
}

const SETTINGS_KEY = "aiReview";

/** One line for the notification: the month in numbers. */
export function reviewSummary(r: MonthlyReviewDTO): string {
  const parts = [
    `${r.questions.total} question${r.questions.total === 1 ? "" : "s"} (${r.questions.answered} answered from sources or records, ${r.questions.unanswered} not)`,
    `${r.ratings.helpful} rated helpful, ${r.ratings.notHelpful} not`,
    `${r.overrides.total} safety override${r.overrides.total === 1 ? "" : "s"}`,
  ];
  if (r.questions.external) parts.push(`${r.questions.external} taken to OpenEvidence`);
  return `${r.label}: ${parts.join("; ")}.`;
}

/**
 * Tell the clinician owners, once a month from the first at 09:00 on the
 * clinic's clock, that last month's review is ready. Nothing when last month
 * had no questions and no overrides.
 */
export async function sendMonthlyReview(tenantId: string, now: Date = new Date()): Promise<"sent" | "already_sent" | "not_due" | "nothing"> {
  const timeZone = await getTenantTimezone(tenantId);
  const p = zonedParts(now, timeZone);
  if (now.getTime() < zonedTimeToUtc({ year: p.year, month: p.month, day: 1, hour: REVIEW_HOUR, minute: 0 }, timeZone).getTime()) return "not_due";
  const reviewed = previousMonthKey(`${p.year}-${pad(p.month)}`);
  const state = await readTenantSetting<{ sentMonth?: string }>(tenantId, SETTINGS_KEY, {});
  if (state.sentMonth === reviewed) return "already_sent";
  const review = await monthlyReview(tenantId, reviewed, now);
  await updateTenantSettings(tenantId, { [SETTINGS_KEY]: { sentMonth: reviewed, sentAt: now.toISOString() } });
  if (!review.questions.total && !review.overrides.total) return "nothing";
  const owners = await db.user.findMany({ where: { tenantId, role: "CLINIC_OWNER", isClinician: true, status: "ACTIVE", deletedAt: null }, select: { id: true } });
  if (!owners.length) return "nothing";
  await notify(tenantId, {
    kind: "AI_REVIEW",
    title: `AI review for ${review.label}`,
    body: reviewSummary(review),
    href: `/dashboard/evidence/review?month=${reviewed}`,
    entity: "AiReview",
    entityId: reviewed,
    userIds: owners.map((o) => o.id),
  });
  return "sent";
}

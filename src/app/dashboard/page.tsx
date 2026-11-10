import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { CalendarDays } from "lucide-react";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { getOverview } from "@/modules/analytics/service";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle, EmptyState, StatStrip, type Stat } from "@/components/ui/primitives";
import { DeltaChip, Columns, HBars } from "@/components/ui/kpi";
import { formatNumber } from "@/lib/utils";
import { NextAppointmentHero } from "@/components/clinicmind/next-appointment-hero";
import { AttentionCard } from "@/components/clinicmind/attention-card";

export const dynamic = "force-dynamic";

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** Weekday of a local date key (YYYY-MM-DD) without timezone drift. */
const weekdayOf = (key: string) => WEEKDAY[new Date(`${key}T12:00:00Z`).getUTCDay()] ?? key;
/** "22 Oct" from a local date key, built from the digits so server and browser agree. */
const dayMonth = (key: string) => `${Number(key.slice(8, 10))} ${(MONTH[Number(key.slice(5, 7)) - 1] ?? "").slice(0, 3)}`;
const longDay = (key: string) => `${weekdayOf(key)} ${Number(key.slice(8, 10))} ${MONTH[Number(key.slice(5, 7)) - 1] ?? ""}`;
const span = (from: string, to: string) => `${dayMonth(from)}–${dayMonth(to)}`;
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

const NO_SHOW_TARGET = 0.08;

type StatKey = "today" | "upcoming" | "noShow" | "drafts" | "signed" | "active" | "patients" | "ai";

/**
 * Which clinic figures a role reads, in order: the desk its bookings, a clinician the notes
 * to sign, the owner all of them. The day's work (who is next, what is waiting) comes first
 * on the page for everyone; the figures support it.
 */
function statsFor(role: UserRole): StatKey[] {
  switch (role) {
    case "RECEPTIONIST":
    case "ASSISTANT":
      return ["today", "upcoming", "noShow", "patients"];
    case "DOCTOR":
    case "NURSE":
      return ["today", "drafts", "active", "signed"];
    default:
      return ["today", "upcoming", "noShow", "drafts", "signed", "active", "patients", "ai"];
  }
}

export default async function OverviewPage() {
  const ctx = await getActingContext();
  const m = ctx ? await getOverview(ctx.tenantId) : null;
  const trend = m?.appointmentTrend ?? [];
  const thisWeek = trend.slice(-7);
  const lastWeek = trend.slice(0, Math.max(0, trend.length - 7));
  const noShow = m?.noShowRate ?? 0;
  const w = m?.windows ?? null;
  // Each chip's tooltip names both values and both windows.
  const labels = w
    ? {
        week: [`in the last 7 days (${span(w.weekFrom, w.today)})`, `in the 7 days before (${span(w.prevWeekFrom, w.prevWeekTo)})`],
        fortnight: [`in the last 14 days (${span(w.fortnightFrom, w.today)})`, `in the 14 days before (${span(w.prevFortnightFrom, w.prevFortnightTo)})`],
        registry: ["patients now", `patients 7 days ago (start of ${dayMonth(w.weekFrom)})`],
        today: [`today (${dayMonth(w.today)})`, `the same day last week (${dayMonth(w.sameDayLastWeek)})`],
      }
    : null;

  const booked = m?.appointmentsToday ?? 0;
  const day = [
    w ? longDay(w.today) : null,
    m ? (booked ? `${formatNumber(booked)} ${booked === 1 ? "appointment" : "appointments"}: ${formatNumber(m.appointmentsTodayDone)} done, ${formatNumber(m.appointmentsTodayToCome)} to come` : "no appointments today") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const all: Record<StatKey, Stat> = {
    today: {
      label: "Appointments today",
      value: formatNumber(booked),
      delta: <DeltaChip current={booked} previous={m?.appointmentsSameDayLastWeek} goodWhen="up" currentLabel={labels?.today[0]} previousLabel={labels?.today[1]} />,
      hint: `${formatNumber(m?.appointmentsTodayDone ?? 0)} done · ${formatNumber(m?.appointmentsTodayToCome ?? 0)} to come`,
    },
    upcoming: {
      label: "Next 7 days",
      value: formatNumber(m?.upcoming7 ?? 0),
      hint: `${formatNumber(m?.upcoming ?? 0)} booked in total`,
    },
    noShow: {
      label: "No-show rate, 14 days",
      value: pct(noShow),
      tone: noShow > NO_SHOW_TARGET ? "warning" : "default",
      // A rate moves in percentage points; no chip until both windows had bookings due.
      delta: m?.noShowDue ? (
        <DeltaChip current={noShow} previous={m.noShowRatePrev} goodWhen="down" format={pct} mode="points" currentLabel={labels?.fortnight[0]} previousLabel={labels?.fortnight[1]} />
      ) : null,
      hint: m?.noShowDue
        ? `${formatNumber(m.noShows)} of ${formatNumber(m.noShowDue)} past bookings · ${noShow > NO_SHOW_TARGET ? "above" : "within"} the ${pct(NO_SHOW_TARGET)} target`
        : "no booking was due yet",
    },
    drafts: {
      label: "Drafts to sign",
      value: formatNumber(m?.pendingReview ?? 0),
      tone: m?.pendingReview ? "warning" : "default",
      hint: "consultations awaiting a clinician",
    },
    signed: {
      label: "Signed visits, 14 days",
      value: formatNumber(m?.signedVisits14 ?? 0),
      delta: <DeltaChip current={m?.signedVisits14 ?? 0} previous={m?.signedVisitsPrev14} goodWhen="up" currentLabel={labels?.fortnight[0]} previousLabel={labels?.fortnight[1]} />,
    },
    active: {
      label: "Open consultations",
      value: formatNumber(m?.activeConsultations ?? 0),
      hint: "recording, transcribing, extracting or in review",
    },
    patients: {
      label: "Total patients",
      value: formatNumber(m?.patients ?? 0),
      // Growth of the registry: the total now against the total 7 days ago.
      delta: <DeltaChip current={m?.patients ?? 0} previous={m?.patientsWeekAgo} goodWhen="up" format={formatNumber} currentLabel={labels?.registry[0]} previousLabel={labels?.registry[1]} />,
      hint: `${formatNumber(m?.patientsNew7 ?? 0)} new this week`,
    },
    ai: {
      label: "AI interactions, 7 days",
      value: formatNumber(m?.aiInteractions ?? 0),
      delta: <DeltaChip current={m?.aiInteractions ?? 0} previous={m?.aiInteractionsPrev} goodWhen="up" currentLabel={labels?.week[0]} previousLabel={labels?.week[1]} />,
      hint: "extractions, answers and transcriptions",
    },
  };
  const role = ctx?.role ?? "ASSISTANT";
  const desk = role === "RECEPTIONIST" || role === "ASSISTANT";

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <SectionTitle
          title="Today"
          description={day || undefined}
          action={
            ctx && can(ctx.role, "appointments:read") ? (
              <Button asChild variant="outline">
                <Link href="/dashboard/appointments?view=day">
                  <CalendarDays />
                  Today&apos;s schedule
                </Link>
              </Button>
            ) : null
          }
        />
        {/* The day's work first: who is next, and what is waiting for this person. */}
        {ctx ? (
          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <NextAppointmentHero tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} />
            <AttentionCard tenantId={ctx.tenantId} userId={ctx.userId} role={ctx.role} />
          </div>
        ) : null}
      </div>

      <section className="space-y-3">
        <SectionTitle level="section" title="Clinic figures" description="The whole clinic, with the change against the period before." />
        <StatStrip stats={statsFor(role).map((key) => all[key])} data-testid="overview-figures" />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className={desk ? "lg:col-span-3" : "lg:col-span-2"}>
          <SectionTitle title="Appointment volume" description="Booked appointments per day, this week against last week." />
          <div className="mt-4">
            {thisWeek.length ? (
              <Columns
                items={thisWeek.map((d, i) => ({ label: weekdayOf(d.day).slice(0, 3), value: d.count, compare: lastWeek[i]?.count }))}
                note="Solid: this week. Grey: the same weekday last week."
              />
            ) : (
              <EmptyState title="No appointments yet" hint="The chart fills as bookings are made." />
            )}
          </div>
        </Card>

        {/* What the clinic treats is a clinician's and an owner's question, not the desk's. */}
        {desk ? null : (
          <Card>
            <SectionTitle title="Diagnoses" description="Most frequent across the patient population." />
            <div className="mt-4">
              {m?.diagnoses.length ? (
                <HBars items={m.diagnoses.map((d) => ({ label: d.label, value: d.count }))} labelWidth="w-32 sm:w-40" />
              ) : (
                <EmptyState title="No diagnosis data yet" hint="Diagnoses populate as consultations are signed." />
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

import { getActingContext } from "@/lib/auth/session";
import { getOverview } from "@/modules/analytics/service";
import { Card, SectionTitle, Badge, EmptyState } from "@/components/ui/primitives";
import { Kpi, DeltaChip, Columns, HBars } from "@/components/ui/kpi";
import { formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Weekday label of a local date key (YYYY-MM-DD) without timezone drift. */
const weekdayOf = (key: string) => WEEKDAY[new Date(`${key}T12:00:00Z`).getUTCDay()] ?? key;
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export default async function OverviewPage() {
  const ctx = await getActingContext();
  const m = ctx ? await getOverview(ctx.tenantId) : null;
  const trend = m?.appointmentTrend ?? [];
  const thisWeek = trend.slice(-7);
  const lastWeek = trend.slice(0, Math.max(0, trend.length - 7));
  const noShow = m?.noShowRate ?? 0;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Clinic Intelligence"
        description="Operating metrics across appointments, patients and AI activity, with the change against the previous period."
        action={<Badge tone="accent">live</Badge>}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi
          label="Total patients"
          value={formatNumber(m?.patients ?? 0)}
          tone="accent"
          delta={<DeltaChip current={m?.patientsNew7 ?? 0} previous={m?.patientsNewPrev7} goodWhen="up" />}
          hint={`${formatNumber(m?.patientsNew7 ?? 0)} new this week`}
          spark={m?.newPatientsWeekly}
        />
        <Kpi
          label="Appointments today"
          value={formatNumber(m?.appointmentsToday ?? 0)}
          delta={<DeltaChip current={m?.appointmentsToday ?? 0} previous={m?.appointmentsSameDayLastWeek} goodWhen="up" />}
          hint={`${formatNumber(m?.appointmentsTodayDone ?? 0)} done · ${formatNumber(m?.appointmentsTodayToCome ?? 0)} to come`}
          spark={trend.map((d) => d.count)}
        />
        <Kpi
          label="Upcoming 7 days"
          value={formatNumber(m?.upcoming7 ?? 0)}
          hint={`${formatNumber(m?.upcoming ?? 0)} booked in total`}
        />
        <Kpi
          label="No-show rate · 14 d"
          value={pct(noShow)}
          tone={noShow > 0.08 ? "warning" : "default"}
          delta={<DeltaChip current={noShow} previous={m?.noShowRatePrev} goodWhen="down" format={pct} />}
          target={{ ok: noShow <= 0.08, text: "target ≤ 8%" }}
        />
        <Kpi
          label="Drafts to sign"
          value={formatNumber(m?.pendingReview ?? 0)}
          tone={m?.pendingReview ? "warning" : "default"}
          hint="consultations awaiting a clinician"
        />
        <Kpi
          label="Active consultations"
          value={formatNumber(m?.activeConsultations ?? 0)}
          hint="recording, transcribing, extracting or in review"
        />
        <Kpi
          label="AI interactions · 7 d"
          value={formatNumber(m?.aiInteractions ?? 0)}
          delta={<DeltaChip current={m?.aiInteractions ?? 0} previous={m?.aiInteractionsPrev} goodWhen="up" />}
          hint="extractions, answers and transcriptions"
        />
        <Kpi
          label="Signed visits · 14 d"
          value={formatNumber(m?.signedVisits14 ?? 0)}
          delta={<DeltaChip current={m?.signedVisits14 ?? 0} previous={m?.signedVisitsPrev14} goodWhen="up" />}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="Appointment volume" description="Booked appointments per day, this week against last week." />
          <div className="mt-4">
            {thisWeek.length ? (
              <Columns
                items={thisWeek.map((d, i) => ({ label: weekdayOf(d.day), value: d.count, compare: lastWeek[i]?.count }))}
                note="Solid: this week. Grey: the same weekday last week."
              />
            ) : (
              <EmptyState title="No appointments yet" hint="The chart fills as bookings are made." />
            )}
          </div>
        </Card>

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
      </div>
    </div>
  );
}

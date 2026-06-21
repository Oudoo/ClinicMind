import { getActingContext } from "@/lib/auth/session";
import { getOverview } from "@/modules/analytics/service";
import { Bento, Card, Metric, SectionTitle, Badge, EmptyState } from "@/components/ui/primitives";
import { SparkChart } from "@/components/ui/spark-chart";
import { formatNumber } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const ctx = await getActingContext();
  const metrics = ctx ? await getOverview(ctx.tenantId) : null;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Clinic Intelligence"
        description="Real-time operating metrics across appointments, patients and AI activity."
        action={<Badge tone="accent">7-day window</Badge>}
      />

      <Bento>
        <Metric label="Total Patients" value={formatNumber(metrics?.patients ?? 0)} tone="accent" />
        <Metric
          label="Appointments Today"
          value={formatNumber(metrics?.appointmentsToday ?? 0)}
        />
        <Metric label="Upcoming" value={formatNumber(metrics?.upcoming ?? 0)} />
        <Metric
          label="No-show Rate"
          value={`${Math.round((metrics?.noShowRate ?? 0) * 100)}%`}
          tone={metrics && metrics.noShowRate > 0.15 ? "warning" : "default"}
        />
      </Bento>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle title="Appointment Volume" description="Daily booked appointments" />
          <div className="mt-4">
            <SparkChart data={metrics?.appointmentTrend ?? []} />
          </div>
        </Card>

        <Card>
          <SectionTitle title="AI Activity" />
          <div className="mt-4 space-y-4">
            <div className="flex items-baseline justify-between">
              <span className="data-label">interactions</span>
              <span className="metric-value text-accent">
                {formatNumber(metrics?.aiInteractions ?? 0)}
              </span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="data-label">active consultations</span>
              <span className="metric-value">
                {formatNumber(metrics?.activeConsultations ?? 0)}
              </span>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <SectionTitle
          title="Diagnoses Distribution"
          description="Most frequent diagnoses across the patient population"
        />
        <div className="mt-4">
          {metrics?.diagnoses.length ? (
            <ul className="space-y-2">
              {metrics.diagnoses.map((d) => {
                const max = metrics.diagnoses[0]?.count ?? 1;
                return (
                  <li key={d.label} className="flex items-center gap-3">
                    <span className="w-40 truncate text-sm">{d.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-indigo-flow"
                        style={{ width: `${(d.count / max) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono text-xs tabular-nums">{d.count}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              title="No diagnosis data yet"
              hint="Diagnoses populate as consultations are signed."
            />
          )}
        </div>
      </Card>
    </div>
  );
}

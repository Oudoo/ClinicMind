import type { Metadata } from "next";
import Link from "next/link";
import { getActingContext } from "@/lib/auth/session";
import { can, canSignClinical } from "@/lib/auth/rbac";
import { addDays, dateKeyInTz, formatDateInTz, formatTimeInTz, fromDateKey } from "@/lib/time";
import { formatNumber } from "@/lib/utils";
import { listUnbilled } from "@/modules/finance/unbilled";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { NoChargeButton } from "@/components/clinicmind/unbilled-actions";
import { ProcedureSignButton, ProcedureStageButton, ProcedureStartButton } from "@/components/clinicmind/procedure-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Not billed" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/dashboard/finance/unbilled` — the day's work not billed yet, for the
 * front desk (`payments:write`) and the owner: visits that took place with
 * no procedure, fee or charge for that patient that day, and procedures done
 * that day still waiting to be signed or started. Each row has what can be
 * done about it here: mark the session of a course under way done, sign,
 * start, or charge a free visit nothing with the reason.
 */
export default async function UnbilledPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="The front desk and the clinic owner go through the day's unbilled work." />;
  }
  const asked = first(sp.date);
  const day = await listUnbilled(ctx.tenantId, { date: asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : undefined }).catch(() => listUnbilled(ctx.tenantId, {}));
  const { timezone } = day;
  const dayStart = fromDateKey(day.date, timezone) ?? new Date();
  const today = dateKeyInTz(new Date(), timezone);
  const previous = dateKeyInTz(addDays(dayStart, -1, timezone), timezone);
  const next = dateKeyInTz(addDays(dayStart, 1, timezone), timezone);
  const long = formatDateInTz(dayStart, timezone, { weekday: "long", day: "numeric", month: "long" });
  const time = (iso: string) => formatTimeInTz(new Date(iso), timezone);
  const canSign = canSignClinical(ctx);
  const canStart = can(ctx.role, "patients:write");
  const canNoCharge = can(ctx.role, "payments:write");
  const isToday = day.date === today;

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Not billed"
        description={`Work done ${isToday ? "today" : `on ${long}`} with nothing billed for it yet. Go through it before closing the day.`}
      />

      <Card className="flex flex-wrap items-end justify-between gap-3 p-4">
        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Choose a day">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Day
            <Input type="date" name="date" defaultValue={day.date} max={today} className="w-44" />
          </label>
          <Button type="submit" variant="outline">
            Show
          </Button>
        </form>
        <nav aria-label="Other days" className="flex flex-wrap gap-4 text-sm">
          <Link href={`/dashboard/finance/unbilled?date=${previous}`} className="text-accent underline-offset-2 hover:underline">
            ← Day before
          </Link>
          {day.date < today ? (
            <Link href={`/dashboard/finance/unbilled?date=${next}`} className="text-accent underline-offset-2 hover:underline">
              Day after →
            </Link>
          ) : null}
          {isToday ? null : (
            <Link href="/dashboard/finance/unbilled" className="text-accent underline-offset-2 hover:underline">
              Today
            </Link>
          )}
        </nav>
      </Card>

      {day.visits.length === 0 && day.procedures.length === 0 ? (
        <EmptyState
          title={isToday ? "Everything done so far today is billed" : `Everything done on ${long} is billed`}
          hint="A visit leaves this list once the patient has a procedure, a consultation fee or a charge that day."
        />
      ) : null}

      {day.visits.length ? (
        <Card className="space-y-2">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            Visits with nothing billed <Badge tone="warning">{day.visits.length}</Badge>
          </h2>
          <ul className="divide-y divide-border">
            {day.visits.map((v) => (
              <li key={v.appointmentId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">{time(v.startsAt)}</span>
                    <Link href={`/dashboard/patients/${v.patientId}`} className="font-medium underline-offset-2 hover:underline">
                      {v.patientName}
                    </Link>
                    <Badge>{v.kindLabel}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{[v.treatmentName, v.doctorName].filter(Boolean).join(" · ") || "No treatment or doctor on the booking"}</p>
                  {v.course ? (
                    <p className="text-xs text-muted-foreground">
                      Course under way: {v.course.label}, session {v.course.nextStage} of {v.course.stages} next
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {v.course && canSign ? (
                    <ProcedureStageButton
                      procedureId={v.course.procedureId}
                      label={`${v.course.label} for ${v.patientName}`}
                      nextStage={v.course.nextStage}
                      stages={v.course.stages}
                      share={v.course.share}
                      timezone={timezone}
                      appointmentId={v.appointmentId}
                      defaultWhen={v.startsAt}
                    />
                  ) : null}
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/dashboard/patients/${v.patientId}`}>Record on the patient</Link>
                  </Button>
                  {canNoCharge ? <NoChargeButton appointmentId={v.appointmentId} label={`${v.kindLabel} for ${v.patientName} at ${time(v.startsAt)}`} /> : null}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {day.procedures.length ? (
        <Card className="space-y-2">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold">
            Done, not signed <Badge tone="warning">{day.procedures.length}</Badge>
          </h2>
          <ul className="divide-y divide-border">
            {day.procedures.map((p) => {
              const label = `${p.label} for ${p.patientName}`;
              return (
                <li key={p.procedureId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{time(p.performedAt)}</span>
                      <Link href={`/dashboard/patients/${p.patientId}`} className="font-medium underline-offset-2 hover:underline">
                        {p.patientName}
                      </Link>
                      <span className="font-mono text-xs tabular-nums">{formatNumber(p.net)} EGP</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {p.label}
                      {p.doctorName ? ` · ${p.doctorName}` : ""}
                      {p.waitingFor === "start" ? ` · ${p.stages} sessions, not started` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {p.waitingFor === "signature" && canSign ? <ProcedureSignButton procedureId={p.procedureId} label={label} /> : null}
                    {p.waitingFor === "start" && canStart ? <ProcedureStartButton procedureId={p.procedureId} label={label} stages={p.stages} timezone={timezone} /> : null}
                    {p.waitingFor === "signature" && !canSign ? <span className="text-xs text-muted-foreground">Waiting for a clinician to sign</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

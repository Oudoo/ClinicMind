import Link from "next/link";
import type { UserRole } from "@prisma/client";
import { can } from "@/lib/auth/rbac";
import { endOfDayInTz, formatTimeInTz, startOfDayInTz, zonedParts } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getTenantTimezone, getWorkingHours, listAppointments } from "@/modules/appointments/service";
import { initialsOf } from "@/modules/appointments/slots";
import { STATUS_LABEL, type AppointmentStatus } from "@/modules/appointments/transitions";

/**
 * Today on the clinic clock, hour by hour: one lane per doctor, each visit placed at its time
 * and drawn by where it stands. Done visits fade back, the visit under way is in ink, a patient
 * waiting in the clinic has an amber edge and a no-show a red one; the ink line is now. The
 * overview's one rich moment: the rest of the page stays quiet around it.
 */

const HIDDEN: AppointmentStatus[] = ["CANCELLED", "WAITLISTED"];

const BLOCK: Record<AppointmentStatus, string> = {
  SCHEDULED: "bg-card text-foreground ring-1 ring-inset ring-border",
  CONFIRMED: "bg-card text-foreground ring-1 ring-inset ring-foreground/25",
  CHECKED_IN: "bg-warning/10 text-foreground ring-1 ring-inset ring-warning/60",
  IN_PROGRESS: "bg-accent text-accent-foreground",
  COMPLETED: "bg-muted text-muted-foreground",
  NO_SHOW: "bg-card text-danger ring-1 ring-inset ring-danger/50 line-through decoration-danger/60",
  CANCELLED: "",
  WAITLISTED: "",
};

const toMinutes = (hhmm: string) => {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
};

export async function TodayRail({ tenantId, role }: { tenantId: string; role: UserRole }) {
  if (!can(role, "appointments:read")) return null;
  const [timezone, hours] = await Promise.all([getTenantTimezone(tenantId), getWorkingHours(tenantId)]);
  const now = new Date();
  const rows = await listAppointments(tenantId, { from: startOfDayInTz(now, timezone), to: endOfDayInTz(now, timezone) });
  const visits = rows.filter((a) => !HIDDEN.includes(a.status as AppointmentStatus));

  const clock = (d: Date) => {
    const p = zonedParts(d, timezone);
    return p.hour * 60 + p.minute;
  };
  // The rail spans the opening hours, widened to any visit booked outside them.
  const open = Math.min(toMinutes(hours.start), ...visits.map((a) => clock(new Date(a.startsAt))));
  const close = Math.max(toMinutes(hours.end), ...visits.map((a) => clock(new Date(a.endsAt))));
  const first = Math.floor(open / 60) * 60;
  const last = Math.ceil(close / 60) * 60;
  const span = Math.max(60, last - first);
  const at = (minutes: number) => `${((minutes - first) / span) * 100}%`;
  const ticks = Array.from({ length: span / 60 + 1 }, (_, i) => first + i * 60);
  const nowMin = clock(now);
  const showNow = nowMin >= first && nowMin <= last;

  const lanes = new Map<string, { name: string; visits: typeof visits }>();
  for (const a of visits) {
    const key = a.doctor?.id ?? "none";
    const lane = lanes.get(key) ?? { name: a.doctor?.fullName ?? "No doctor", visits: [] };
    lane.visits.push(a);
    lanes.set(key, lane);
  }
  const done = visits.filter((a) => a.status === "COMPLETED").length;
  const underWay = visits.find((a) => a.status === "IN_PROGRESS");

  return (
    <section className="bento" aria-labelledby="today-rail-title" data-testid="today-rail">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id="today-rail-title" className="section-title-heading">
          The day, hour by hour
        </h3>
        <p className="text-xs text-muted-foreground tabular-nums">
          {visits.length
            ? `${formatNumber(visits.length)} ${visits.length === 1 ? "visit" : "visits"} · ${formatNumber(done)} done${underWay ? ` · ${underWay.patient.fullName} under way` : ""}`
            : "Nothing booked today"}
        </p>
      </div>

      {visits.length ? (
        // The rail keeps its proportions on a phone and scrolls inside its own box.
        <div className="-mx-1 mt-4 overflow-x-auto px-1 pb-1">
          {/* The end margin leaves room for the last hour's label, which centres on the edge. */}
          <div className="relative me-3 min-w-[48rem]">
            <div className="relative ms-28 h-5" aria-hidden="true">
              {ticks.map((t) => (
                <span key={t} className="absolute -translate-x-1/2 font-mono text-xs text-muted-foreground" style={{ left: at(t) }}>
                  {String(Math.floor(t / 60)).padStart(2, "0")}
                </span>
              ))}
            </div>
            <ol className="space-y-2">
              {[...lanes.entries()].map(([key, lane]) => (
                <li key={key} className="flex items-center gap-0">
                  <span className="w-28 shrink-0 truncate pe-3 text-xs text-muted-foreground" title={lane.name}>
                    {lane.name.replace(/^Dr\.?\s+/, "Dr. ")}
                  </span>
                  <ol className="relative h-9 flex-1 rounded-lg bg-muted/60" aria-label={`${lane.name}: ${lane.visits.length} visits`}>
                    {ticks.slice(1, -1).map((t) => (
                      <span key={t} className="absolute inset-y-1 w-px bg-border" style={{ left: at(t) }} aria-hidden="true" />
                    ))}
                    {lane.visits.map((a) => {
                      const start = new Date(a.startsAt);
                      const end = new Date(a.endsAt);
                      const s = clock(start);
                      const e = Math.max(s + 10, clock(end));
                      // A name fits from about 40 minutes at full width; shorter visits show initials.
                      const wide = e - s >= 40;
                      const label = `${formatTimeInTz(start, timezone)}–${formatTimeInTz(end, timezone)} · ${a.patient.fullName} · ${STATUS_LABEL[a.status as AppointmentStatus]}`;
                      return (
                        <li key={a.id} className="absolute inset-y-1" style={{ left: at(s), width: `calc(${at(e)} - ${at(s)} - 2px)` }}>
                          <Link
                            href={`/dashboard/patients/${a.patientId}`}
                            title={label}
                            className={cn(
                              "flex h-full items-center overflow-hidden rounded-md px-1.5 text-xs font-medium transition-colors hover:brightness-95",
                              BLOCK[a.status as AppointmentStatus],
                            )}
                          >
                            <span className="sr-only">{label}</span>
                            <span aria-hidden="true" className="truncate">
                              {wide ? a.patient.fullName.split(" ")[0] : initialsOf(a.patient.fullName)}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                </li>
              ))}
            </ol>
            {showNow ? (
              <div className="pointer-events-none absolute bottom-0 top-5 ms-28 w-[calc(100%-7rem)]" aria-hidden="true">
                <span className="absolute inset-y-0 w-0.5 rounded-full bg-accent" style={{ left: at(nowMin) }} />
                <span
                  className="absolute -top-5 -translate-x-1/2 rounded bg-accent px-1 font-mono text-xs text-accent-foreground"
                  style={{ left: at(nowMin) }}
                >
                  {formatTimeInTz(now, timezone)}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">The rail fills as visits are booked for today.</p>
      )}
    </section>
  );
}

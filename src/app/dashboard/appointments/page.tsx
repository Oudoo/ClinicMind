import type { Metadata } from "next";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import {
  addDays,
  dateKeyInTz,
  endOfDayInTz,
  formatDateInTz,
  fromDateKey,
  startOfDayInTz,
  startOfWeekInTz,
} from "@/lib/time";
import { getTenantTimezone, getWorkingHours, listAppointments, listStaff } from "@/modules/appointments/service";
import { toAppointmentDTO } from "@/modules/appointments/dto";
import { withPatientBalances } from "@/modules/finance/ledger";
import { AppointmentCalendar, type CalendarView } from "@/components/clinicmind/appointment-calendar";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Appointments" };

/**
 * `/dashboard/appointments?view=week|day&date=YYYY-MM-DD&doctorId=`
 *
 * Day and week boundaries follow the clinic's timezone (first clinic of the
 * tenant); the week starts on Saturday.
 */
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; doctorId?: string }>;
}) {
  const params = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;

  const timezone = await getTenantTimezone(ctx.tenantId);
  const view: CalendarView = params.view === "day" ? "day" : "week";
  const now = new Date();
  const anchor = (params.date ? fromDateKey(params.date, timezone) : null) ?? startOfDayInTz(now, timezone);
  const doctorFilter = params.doctorId?.trim().slice(0, 64) || undefined;

  const rangeStart = view === "week" ? startOfWeekInTz(anchor, timezone) : anchor;
  const dayCount = view === "week" ? 7 : 1;
  const rangeEnd = endOfDayInTz(addDays(rangeStart, dayCount - 1, timezone), timezone);

  const [appointments, doctors, hours] = await Promise.all([
    listAppointments(ctx.tenantId, { from: rangeStart, to: rangeEnd, doctorId: doctorFilter }),
    // Clinicians, plus the nurses who hold nurse-led procedure sessions.
    listStaff(ctx.tenantId, { kind: "PROCEDURE" }),
    getWorkingHours(ctx.tenantId),
  ]);

  const days = Array.from({ length: dayCount }, (_, i) => {
    const day = addDays(rangeStart, i, timezone);
    return {
      key: dateKeyInTz(day, timezone),
      label: formatDateInTz(day, timezone, { weekday: "short", day: "2-digit", month: "short" }),
    };
  });

  const anchorKey = dateKeyInTz(anchor, timezone);
  const step = dayCount;
  const rangeLabel =
    view === "week"
      ? `${formatDateInTz(rangeStart, timezone, { day: "2-digit", month: "short" })} – ${formatDateInTz(rangeEnd, timezone)}`
      : formatDateInTz(anchor, timezone, { weekday: "long", day: "2-digit", month: "short", year: "numeric" });

  return (
    <AppointmentCalendar
      view={view}
      timezone={timezone}
      anchorKey={anchorKey}
      todayKey={dateKeyInTz(now, timezone)}
      rangeLabel={rangeLabel}
      days={days}
      appointments={await withPatientBalances(ctx.tenantId, ctx.role, appointments.map(toAppointmentDTO))}
      doctors={doctors}
      hours={hours}
      doctorId={doctorFilter ?? ""}
      nav={{
        prev: dateKeyInTz(addDays(anchor, -step, timezone), timezone),
        next: dateKeyInTz(addDays(anchor, step, timezone), timezone),
        today: dateKeyInTz(now, timezone),
      }}
      canWrite={can(ctx.role, "appointments:write")}
      canManage={can(ctx.role, "users:manage")}
      userId={ctx.userId}
    />
  );
}

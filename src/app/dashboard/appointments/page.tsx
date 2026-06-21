import { getActingContext } from "@/lib/auth/session";
import { listAppointments } from "@/modules/appointments/service";
import { Card, SectionTitle, Badge, EmptyState } from "@/components/ui/primitives";
import { formatTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, "default" | "accent" | "success" | "warning" | "danger"> = {
  SCHEDULED: "default",
  CONFIRMED: "accent",
  CHECKED_IN: "accent",
  IN_PROGRESS: "accent",
  COMPLETED: "success",
  CANCELLED: "danger",
  NO_SHOW: "danger",
  WAITLISTED: "warning",
};

export default async function AppointmentsPage() {
  const ctx = await getActingContext();
  const now = new Date();
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 7);

  const appointments = ctx ? await listAppointments(ctx.tenantId, { from, to }) : [];

  // Group by day for a week column view.
  const byDay = new Map<string, typeof appointments>();
  for (const a of appointments) {
    const key = a.startsAt.toISOString().slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), a]);
  }
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    return d;
  });

  return (
    <div className="space-y-6">
      <SectionTitle
        title="Appointments"
        description="Week schedule with conflict detection & waitlist."
        action={<Badge tone="accent">{appointments.length} this week</Badge>}
      />

      {appointments.length ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {days.map((d) => {
            const key = d.toISOString().slice(0, 10);
            const list = byDay.get(key) ?? [];
            return (
              <Card key={key} className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="data-label">
                    {d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}
                  </span>
                  <span className="font-mono text-xs text-muted-foreground">{list.length}</span>
                </div>
                <div className="space-y-2">
                  {list.length ? (
                    list.map((a) => (
                      <div key={a.id} className="rounded-md border border-border p-2.5">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs tabular-nums">
                            {formatTime(a.startsAt)}
                          </span>
                          <Badge tone={STATUS_TONE[a.status] ?? "default"}>{a.status}</Badge>
                        </div>
                        <p className="mt-1 truncate text-sm font-medium">{a.patient.fullName}</p>
                        {a.reason ? (
                          <p className="truncate text-xs text-muted-foreground">{a.reason}</p>
                        ) : null}
                      </div>
                    ))
                  ) : (
                    <p className="py-4 text-center text-xs text-muted-foreground">—</p>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            title="No appointments scheduled"
            hint="Bookings from the AI receptionist or front desk appear here."
          />
        </Card>
      )}
    </div>
  );
}

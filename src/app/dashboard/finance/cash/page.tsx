import type { Metadata } from "next";
import Link from "next/link";
import { ZodError } from "zod";
import { getActingContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { addDays, dateKeyInTz, formatDateInTz, formatTimeInTz, fromDateKey } from "@/lib/time";
import { cn, formatNumber } from "@/lib/utils";
import { getCashDay, myShift, type DayView, type MethodLine, type ShiftView } from "@/modules/finance/cash";
import { Badge, Card, EmptyState, SectionTitle } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { NotForRole } from "@/components/clinicmind/report-shared";
import { CloseShiftButton, OpenShiftForm, SignOffDayButton } from "@/components/clinicmind/cash-drawer";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Cash drawer" };

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/dashboard/finance/cash?date=YYYY-MM-DD&clinicId=` — the cash drawer: the
 * cashier's own shift (open it with the float, close it with the count), and
 * a branch's day: every shift with what was expected and counted per method,
 * the money outside the shifts, the totals, and the owner's sign-off that
 * locks the day.
 */
export default async function CashPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const ctx = await getActingContext();
  if (!ctx) return null;
  if (!can(ctx.role, "payments:write") && !can(ctx.role, "finance:read")) {
    return <NotForRole title="Not available for your role" hint="The cash drawer is for the front desk and the clinic owner." />;
  }
  const takes = can(ctx.role, "payments:write");
  const owner = can(ctx.role, "tenant:manage");
  const query = { date: first(sp.date), clinicId: first(sp.clinicId) };
  const day: DayView = await getCashDay(ctx.tenantId, query).catch((err: unknown) => {
    if (err instanceof ZodError) return getCashDay(ctx.tenantId, { clinicId: query.clinicId });
    throw err;
  });
  const mine = takes && ctx.userId ? await myShift(ctx.tenantId, ctx.userId) : null;
  const tz = day.timezone;
  const dayStart = fromDateKey(day.date, tz)!;
  const label = formatDateInTz(dayStart, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const href = (date: string) => `/dashboard/finance/cash?${new URLSearchParams({ date, ...(day.clinics.length > 1 ? { clinicId: day.clinic.id } : {}) }).toString()}`;
  const prev = dateKeyInTz(addDays(dayStart, -1, tz), tz);
  const next = dateKeyInTz(addDays(dayStart, 1, tz), tz);
  const time = (iso: string) => formatTimeInTz(new Date(iso), tz);
  const openShifts = day.shifts.filter((s) => s.status === "OPEN");
  const counted = day.totals.every((t) => t.counted !== null);

  return (
    <div className="space-y-6">
      <SectionTitle title="Cash drawer" description="Open your shift with the cash in the drawer, take the day's money in it, and count it at the close. The owner signs the day off." />

      {takes ? (
        <Card className="space-y-4" data-testid="my-shift">
          <SectionTitle
            title="My shift"
            description={mine ? `Open since ${formatDateInTz(new Date(mine.openedAt), tz, { day: "numeric", month: "short" })}, ${time(mine.openedAt)} · ${formatNumber(mine.openingFloat)} EGP float · ${mine.payments} payment${mine.payments === 1 ? "" : "s"}` : "No shift open: money taken today goes into your shift, so open it first."}
            action={mine ? <Badge tone="success">open</Badge> : null}
          />
          {mine ? (
            <>
              {dateKeyInTz(new Date(mine.openedAt), tz) < day.today ? (
                <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm" data-testid="stale-shift">
                  This shift is from an earlier day: it takes no more money. Count it and close it, then open today&apos;s.
                </p>
              ) : null}
              <MethodsTable methods={mine.methods} />
              <CloseShiftButton shiftId={mine.id} cashier={mine.cashier.fullName} methods={mine.methods.map((m) => ({ method: m.method, label: m.label, expected: m.expected }))} own />
            </>
          ) : (
            <OpenShiftForm clinics={day.clinics} />
          )}
        </Card>
      ) : null}

      <Card className="space-y-4" data-testid="cash-day">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 flex-1 basis-60">
            <h2 className="font-display text-lg font-semibold tracking-tight">{label}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {day.clinic.name}
              {day.signedOff ? ` · signed off by ${day.signedOff.by ?? "the owner"}, ${formatDateInTz(new Date(day.signedOff.at), tz, { day: "numeric", month: "short" })} ${time(day.signedOff.at)}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {day.signedOff ? <Badge tone="success">Signed off</Badge> : <Badge tone={day.date === day.today ? "accent" : "warning"}>{day.date === day.today ? "Today" : "Not signed off"}</Badge>}
            {owner && day.canSignOff && day.shifts.length + day.outside.count > 0 ? <SignOffDayButton date={day.date} dateLabel={label} clinicId={day.clinic.id} /> : null}
          </div>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Day">
          <Link href={href(prev)} className="inline-flex h-10 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted">
            ← Day before
          </Link>
          {day.date < day.today ? (
            <Link href={href(next)} className="inline-flex h-10 items-center rounded-lg border border-border px-3 text-sm hover:bg-muted">
              Day after →
            </Link>
          ) : null}
          <Input type="date" name="date" defaultValue={day.date} max={day.today} aria-label="Date" className="w-40" />
          {day.clinics.length > 1 ? (
            <Select name="clinicId" defaultValue={day.clinic.id} aria-label="Branch" className="w-48">
              {day.clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          ) : null}
          <Button type="submit" variant="outline" className="h-10">
            Show
          </Button>
        </form>

        {day.stale.length ? (
          <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
            Still open from an earlier day: {day.stale.map((s) => `${s.cashier}'s (since ${formatDateInTz(new Date(s.openedAt), tz, { day: "numeric", month: "short" })})`).join(", ")}. Close {day.stale.length === 1 ? "it" : "them"} before signing that day off.
          </p>
        ) : null}
        {openShifts.length && !day.signedOff && day.date < day.today ? (
          <p className="text-sm text-muted-foreground">To sign the day off, close every shift first: {openShifts.map((s) => s.cashier.fullName).join(", ")}.</p>
        ) : null}

        {day.shifts.length ? (
          <div className="space-y-4">
            {day.shifts.map((s) => (
              <ShiftBlock key={s.id} shift={s} time={time} closable={s.status === "OPEN" && (owner || s.cashier.id === ctx.userId)} own={s.cashier.id === ctx.userId} />
            ))}
          </div>
        ) : (
          <EmptyState title="No shift that day" hint={day.date === day.today ? "Shifts appear here as cashiers open them." : "No one took money at the desk."} />
        )}

        {day.outside.count ? (
          <p className="text-sm text-muted-foreground" data-testid="cash-outside">
            Outside the shifts ({day.outside.count} entered late or imported): {day.outside.methods.map((m) => `${m.label} ${formatNumber(m.amount)}`).join(" · ")} EGP
          </p>
        ) : null}

        {day.totals.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" aria-label="Day totals">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="py-2 pe-3 text-start font-normal">The day, by method</th>
                  <th className="py-2 pe-3 text-end font-normal">{counted ? "Expected" : "Expected so far"}</th>
                  {counted ? <th className="py-2 pe-3 text-end font-normal">Counted</th> : null}
                  {counted ? <th className="py-2 text-end font-normal">Difference</th> : null}
                </tr>
              </thead>
              <tbody>
                {day.totals.map((t) => (
                  <tr key={t.method} className="border-b border-border/60">
                    <td className="py-2 pe-3">{t.label}</td>
                    <td className="py-2 pe-3 text-end font-mono tabular-nums">{formatNumber(t.expected)}</td>
                    {t.counted !== null ? <td className="py-2 pe-3 text-end font-mono tabular-nums">{formatNumber(t.counted)}</td> : null}
                    {t.difference !== null ? (
                      <td className={cn("py-2 text-end font-mono tabular-nums", t.difference < 0 && "text-danger", t.difference > 0 && "text-warning")}>{t.difference > 0 ? `+${formatNumber(t.difference)}` : formatNumber(t.difference)}</td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
            {counted ? null : <p className="mt-2 text-xs text-muted-foreground">Counted, with the difference, once every shift of the day is closed.</p>}
          </div>
        ) : null}
      </Card>
    </div>
  );
}

function ShiftBlock({ shift, time, closable, own }: { shift: ShiftView; time: (iso: string) => string; closable: boolean; own: boolean }) {
  return (
    <section className="space-y-2 rounded-lg border border-border p-3" aria-label={`${shift.cashier.fullName}'s shift`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <span className="font-medium">{shift.cashier.fullName}</span>
          <span className="ms-2 text-xs text-muted-foreground">
            {time(shift.openedAt)}–{shift.closedAt ? time(shift.closedAt) : "now"} · float {formatNumber(shift.openingFloat)} EGP · {shift.payments} payment{shift.payments === 1 ? "" : "s"}
          </span>
        </p>
        <div className="flex items-center gap-2">
          <Badge tone={shift.status === "OPEN" ? "accent" : "default"}>{shift.status === "OPEN" ? "open" : "closed"}</Badge>
          {closable ? <CloseShiftButton shiftId={shift.id} cashier={shift.cashier.fullName} methods={shift.methods.map((m) => ({ method: m.method, label: m.label, expected: m.expected }))} own={own} /> : null}
        </div>
      </div>
      <MethodsTable methods={shift.methods} />
      {shift.note ? <p className="text-xs text-muted-foreground">Note: {shift.note}</p> : null}
    </section>
  );
}

function MethodsTable({ methods }: { methods: MethodLine[] }) {
  const counted = methods.some((m) => m.counted !== null);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-1.5 pe-3 text-start font-normal">Method</th>
            <th className="py-1.5 pe-3 text-end font-normal">Expected</th>
            {counted ? <th className="py-1.5 pe-3 text-end font-normal">Counted</th> : null}
            {counted ? <th className="py-1.5 text-end font-normal">Difference</th> : null}
          </tr>
        </thead>
        <tbody>
          {methods.map((m) => (
            <tr key={m.method} className="border-b border-border/60 align-top">
              <td className="py-1.5 pe-3">
                {m.label}
                {m.reason ? <span className="block text-xs text-muted-foreground">{m.reason}</span> : null}
                {m.expectedAtCount !== null ? <span className="block text-xs text-warning">Expected at the count: {formatNumber(m.expectedAtCount)} (changed since)</span> : null}
              </td>
              <td className="py-1.5 pe-3 text-end font-mono tabular-nums">{formatNumber(m.expected)}</td>
              {counted ? <td className="py-1.5 pe-3 text-end font-mono tabular-nums">{m.counted === null ? "—" : formatNumber(m.counted)}</td> : null}
              {counted ? (
                <td className={cn("py-1.5 text-end font-mono tabular-nums", (m.difference ?? 0) < 0 && "text-danger", (m.difference ?? 0) > 0 && "text-warning")}>
                  {m.difference === null ? "—" : m.difference > 0 ? `+${formatNumber(m.difference)}` : formatNumber(m.difference)}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

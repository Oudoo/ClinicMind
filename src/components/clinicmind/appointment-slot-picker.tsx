"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { dateKeyInTz, formatDateInTz, formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { SlotCellDTO } from "@/modules/appointments/dto";
import { STATUS_LABEL, type WorkingHours } from "@/modules/appointments/transitions";
import { useFreeSlots } from "./appointment-shared";

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describeHours(h: WorkingHours): string {
  const days = [...h.days].sort((a, b) => ((a + 1) % 7) - ((b + 1) % 7)).map((d) => WEEKDAY[d]);
  const range = days.length > 2 ? `${days[0]}–${days[days.length - 1]}` : days.join(", ");
  return `${range} ${h.start}–${h.end}`;
}

/**
 * The day's free-slot grid for the chosen doctor (and room): free starts are
 * buttons, taken slots are greyed out with the patient's initials, past slots
 * are dimmed. Picking a cell hands the start instant back to the form.
 */
export function SlotPicker({
  doctorId,
  room,
  date,
  durationMinutes,
  excludeId,
  selectedStart,
  onPick,
  timezone,
  disabled = false,
}: {
  doctorId: string;
  room?: string;
  /** `YYYY-MM-DD` on the clinic clock. */
  date: string;
  durationMinutes: number;
  excludeId?: string;
  /** The form's current start, highlighted when it sits on the grid. */
  selectedStart: Date | null;
  onPick: (startsAtIso: string) => void;
  timezone: string;
  disabled?: boolean;
}) {
  const { data, loading, error } = useFreeSlots(
    doctorId || room ? { doctorId: doctorId || undefined, room: room || undefined, date, duration: durationMinutes, excludeId } : null,
  );

  if (!doctorId && !room) {
    return <p className="text-xs text-muted-foreground">Choose a doctor to see the free slots of the day.</p>;
  }
  if (error) return <p className="text-xs text-danger">{error}</p>;
  if (loading || !data) {
    return (
      <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6" aria-busy="true" aria-label="Loading free slots">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (data.closed) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        The clinic is closed on this day. Opening hours: {describeHours(data.hours)}.
      </p>
    );
  }

  const freeCount = data.slots.filter((s) => s.free).length;
  const selectedKey = selectedStart ? selectedStart.toISOString() : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {freeCount} free of {data.slots.length} · {durationMinutes} min · {describeHours(data.hours)}
        </span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm border border-border bg-card" /> free</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-muted" /> taken</span>
        </span>
      </div>
      <div
        role="listbox"
        aria-label={data.slots[0] ? `Free slots on ${formatDateInTz(new Date(data.slots[0].startsAt), timezone, { weekday: "long", day: "2-digit", month: "short" })}` : "Free slots"}
        className="grid max-h-56 grid-cols-4 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-6"
      >
        {data.slots.map((cell) => (
          <SlotButton
            key={cell.startsAt}
            cell={cell}
            timezone={timezone}
            selected={selectedKey === cell.startsAt}
            disabled={disabled}
            onPick={() => onPick(cell.startsAt)}
          />
        ))}
      </div>
      {data.slots.length && !freeCount ? (
        <p className="text-xs text-muted-foreground">Nothing free on this day; pick another day or ask for the next free slots after booking.</p>
      ) : null}
    </div>
  );
}

function SlotButton({
  cell,
  timezone,
  selected,
  disabled,
  onPick,
}: {
  cell: SlotCellDTO;
  timezone: string;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
}) {
  const start = new Date(cell.startsAt);
  const time = formatTimeInTz(start, timezone);
  const taken = cell.takenBy.length > 0;
  const title = taken
    ? cell.takenBy
        .map(
          (t) =>
            `Taken · ${t.patientName} · ${formatTimeInTz(new Date(t.startsAt), timezone)}–${formatTimeInTz(new Date(t.endsAt), timezone)}${t.room ? ` · ${t.room}` : ""} · ${STATUS_LABEL[t.status]}`,
        )
        .join("\n")
    : cell.past
      ? `${time} has passed`
      : `Book ${time} on ${dateKeyInTz(start, timezone)}`;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      disabled={disabled || !cell.free}
      onClick={onPick}
      title={title}
      aria-label={taken ? `${time}, taken by ${cell.takenBy.map((t) => t.patientInitials).join(", ")}` : cell.past ? `${time}, passed` : `${time}, free`}
      className={cn(
        "flex h-9 flex-col items-center justify-center rounded-md border px-1 text-xs leading-tight transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        cell.free && !selected && "border-border bg-card hover:bg-muted",
        selected && "border-accent bg-accent text-accent-foreground",
        taken && "cursor-not-allowed border-transparent bg-muted text-muted-foreground",
        !taken && cell.past && "cursor-not-allowed border-transparent bg-muted/50 text-muted-foreground/60",
      )}
    >
      <span className="font-mono tabular-nums">{time}</span>
      {taken ? <span className="font-mono text-[10px] uppercase">{cell.takenBy.map((t) => t.patientInitials).join("·")}</span> : null}
    </button>
  );
}

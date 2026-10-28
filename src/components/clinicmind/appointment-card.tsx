"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CalendarClock, Loader2, Mic, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AppointmentDTO } from "@/modules/appointments/dto";
import { availableTransitions, transitionTimeBlock } from "@/modules/appointments/rules";
import {
  allowedTransitions,
  isReschedulable,
  transitionLabel,
  type AppointmentStatus,
} from "@/modules/appointments/transitions";
import { AppointmentKindBadge, AppointmentStatusBadge } from "./appointment-status";

export interface AppointmentActions {
  onTransition: (appointment: AppointmentDTO, status: AppointmentStatus) => void;
  onCancel: (appointment: AppointmentDTO) => void;
  onReschedule: (appointment: AppointmentDTO) => void;
  /** Confirm a no-show before it is recorded (it feeds the no-show rate). */
  onNoShow?: (appointment: AppointmentDTO) => void;
  /** Open the dictated notes of the booking (dictate, read, remove). */
  onNotes?: (appointment: AppointmentDTO) => void;
}

const DESTRUCTIVE: readonly AppointmentStatus[] = ["CANCELLED", "NO_SHOW"];

/**
 * One booking on the schedule: time range, patient (linked to their record),
 * doctor, reason, kind, status, the count of dictated notes and — for
 * writers — a menu with the moves the state machine allows from its current
 * status that the clock also allows right now (no check-in before the day, no
 * no-show before the start), plus "Dictate a note".
 */
export function AppointmentCard({
  appointment,
  timezone,
  canWrite,
  pending = false,
  layout = "compact",
  actions,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  canWrite: boolean;
  pending?: boolean;
  layout?: "compact" | "row";
  actions: AppointmentActions;
}) {
  const start = new Date(appointment.startsAt);
  const end = new Date(appointment.endsAt);
  const time = `${formatTimeInTz(start, timezone)}–${formatTimeInTz(end, timezone)}`;
  const transitions = allowedTransitions(appointment.status);
  const showMenu = canWrite && (transitions.length > 0 || isReschedulable(appointment.status) || Boolean(actions.onNotes));
  const muted = appointment.status === "CANCELLED" || appointment.status === "NO_SHOW";

  const menu = showMenu ? (
    <AppointmentActionsMenu appointment={appointment} timezone={timezone} pending={pending} actions={actions} />
  ) : null;

  const notesBadge =
    appointment.notesCount > 0 ? (
      <button
        type="button"
        onClick={actions.onNotes ? () => actions.onNotes?.(appointment) : undefined}
        disabled={!actions.onNotes}
        aria-label={`${appointment.notesCount} dictated ${appointment.notesCount === 1 ? "note" : "notes"} on this appointment`}
        title={`${appointment.notesCount} dictated ${appointment.notesCount === 1 ? "note" : "notes"}`}
        className="inline-flex h-5 items-center gap-0.5 rounded-md bg-accent-muted px-1.5 font-mono text-[10px] text-accent hover:bg-accent/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <Mic className="h-3 w-3" aria-hidden="true" />
        {appointment.notesCount}
      </button>
    ) : null;

  const details = (
    <>
      <Link
        href={`/dashboard/patients/${appointment.patientId}`}
        className={cn(
          "block truncate text-sm font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
          muted && "text-muted-foreground line-through",
        )}
      >
        {appointment.patient.fullName}
      </Link>
      <p className="truncate text-xs text-muted-foreground">
        {appointment.doctor?.fullName ?? "No doctor assigned"}
        {appointment.room ? ` · ${appointment.room}` : ""}
      </p>
      {appointment.reason ? (
        <p className="truncate text-xs text-muted-foreground" title={appointment.reason}>
          {appointment.reason}
        </p>
      ) : null}
      {appointment.cancelReason && muted ? (
        <p className="truncate text-xs text-danger/80" title={appointment.cancelReason}>
          {appointment.cancelReason}
        </p>
      ) : null}
    </>
  );

  if (layout === "row") {
    return (
      <article
        aria-label={`${time} ${appointment.patient.fullName}`}
        className={cn("flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:gap-4", pending && "opacity-60")}
      >
        <span className="w-28 shrink-0 font-mono text-xs tabular-nums text-foreground">{time}</span>
        <div className="min-w-0 flex-1">{details}</div>
        <div className="flex flex-wrap items-center justify-between gap-2 sm:justify-end">
          {notesBadge}
          <AppointmentKindBadge kind={appointment.kind} />
          <AppointmentStatusBadge status={appointment.status} awaitingSince={appointment.confirmationRequestedAt} />
          {menu}
        </div>
      </article>
    );
  }

  return (
    <article
      aria-label={`${time} ${appointment.patient.fullName}`}
      className={cn("rounded-md border border-border bg-card p-2.5", pending && "opacity-60")}
    >
      {/* Wraps in narrow week columns: the badges and menu drop to a second line instead of overflowing the card. */}
      <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-1">
        <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums">
          {time}
          {notesBadge}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <AppointmentStatusBadge status={appointment.status} awaitingSince={appointment.confirmationRequestedAt} />
          {menu}
        </div>
      </div>
      <div className="mt-1 space-y-0.5">{details}</div>
      <div className="mt-1.5">
        <AppointmentKindBadge kind={appointment.kind} />
      </div>
    </article>
  );
}

function AppointmentActionsMenu({
  appointment,
  timezone,
  pending,
  actions,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  pending: boolean;
  actions: AppointmentActions;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={pending}
          aria-label={`Actions for ${appointment.patient.fullName}'s appointment`}
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[12rem] max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-card p-1 text-sm shadow-lg animate-fade-in"
        >
          {/* Rendered only while the menu is open, so the clock is read when it is opened. */}
          <ActionsMenuItems appointment={appointment} timezone={timezone} actions={actions} />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ActionsMenuItems({ appointment, timezone, actions }: { appointment: AppointmentDTO; timezone: string; actions: AppointmentActions }) {
  const now = new Date();
  const transitions = availableTransitions(appointment, now, timezone);
  const regular = transitions.filter((s) => !DESTRUCTIVE.includes(s));
  const destructive = transitions.filter((s) => DESTRUCTIVE.includes(s));
  const reschedulable = isReschedulable(appointment.status);
  // Say why check-in is missing on a visit that is still ahead.
  const checkInLater =
    allowedTransitions(appointment.status).includes("CHECKED_IN") && !transitions.includes("CHECKED_IN")
      ? transitionTimeBlock(appointment, "CHECKED_IN", now, timezone)
      : null;
  const hint = checkInLater && new Date(appointment.startsAt).getTime() > now.getTime() ? checkInLater.message : null;

  function choose(status: AppointmentStatus) {
    if (status === "CANCELLED") actions.onCancel(appointment);
    else if (status === "NO_SHOW" && actions.onNoShow) actions.onNoShow(appointment);
    else actions.onTransition(appointment, status);
  }

  return (
    <>
      {hint ? (
        <DropdownMenu.Label className="max-w-[16rem] px-2.5 py-1.5 text-xs text-muted-foreground" data-testid="check-in-later-hint">
          {hint}
        </DropdownMenu.Label>
      ) : null}
      {regular.map((status) => (
        <MenuItem key={status} onSelect={() => choose(status)}>
          {transitionLabel(appointment.status, status)}
        </MenuItem>
      ))}
      {reschedulable ? (
        <MenuItem onSelect={() => actions.onReschedule(appointment)}>
          <CalendarClock className="h-4 w-4" />
          Reschedule
        </MenuItem>
      ) : null}
      {actions.onNotes ? (
        <MenuItem onSelect={() => actions.onNotes?.(appointment)}>
          <Mic className="h-4 w-4" />
          {appointment.notesCount ? `Notes · ${appointment.notesCount}` : "Dictate a note"}
        </MenuItem>
      ) : null}
      {destructive.length && (regular.length || reschedulable || actions.onNotes) ? (
        <DropdownMenu.Separator className="my-1 h-px bg-border" />
      ) : null}
      {destructive.map((status) => (
        <MenuItem key={status} onSelect={() => choose(status)} tone="danger">
          {transitionLabel(appointment.status, status)}
          {status === "NO_SHOW" && actions.onNoShow ? "…" : ""}
        </MenuItem>
      ))}
    </>
  );
}

function MenuItem({
  children,
  onSelect,
  tone = "default",
}: {
  children: React.ReactNode;
  onSelect: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-md px-2.5 py-1.5 outline-none data-[highlighted]:bg-muted",
        tone === "danger" ? "text-danger data-[highlighted]:bg-danger/10" : "text-foreground",
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}

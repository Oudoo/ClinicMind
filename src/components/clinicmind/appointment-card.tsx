"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { AlertTriangle, CalendarClock, Loader2, Mic, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import { formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import { isRunningLate } from "@/modules/appointments/countdown";
import type { AppointmentDTO } from "@/modules/appointments/dto";
import { availableTransitions, transitionTimeBlock } from "@/modules/appointments/rules";
import {
  allowedTransitions,
  isReschedulable,
  KIND_LABEL,
  transitionLabel,
  type AppointmentStatus,
} from "@/modules/appointments/transitions";
import { NEXT_STATUS } from "./appointment-shared";
import { AppointmentStatusBadge } from "./appointment-status";
import { BalanceChip } from "./patient-balance";

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
 * what it is for, who with, its status and the count of dictated notes. For
 * writers, the usual next step is one tap in the day's list (confirm, check in,
 * start, complete) and a menu holds every move the state machine allows from
 * the current status that the clock also allows right now (no check-in before
 * the day, no no-show before the start), plus "Dictate a note".
 *
 * `row` is a line of the day's list; `compact` is an entry in a day's column of the week.
 */
export function AppointmentCard({
  appointment,
  timezone,
  now,
  canWrite,
  pending = false,
  layout = "compact",
  showDoctor = true,
  actions,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  /** The clinic's clock now: decides the "late" mark and which next step the clock allows. */
  now: Date;
  canWrite: boolean;
  pending?: boolean;
  layout?: "compact" | "row";
  /** False when the schedule shows one doctor only: the week's entries then say what the visit is for. */
  showDoctor?: boolean;
  actions: AppointmentActions;
}) {
  const start = new Date(appointment.startsAt);
  const end = new Date(appointment.endsAt);
  const time = `${formatTimeInTz(start, timezone)}–${formatTimeInTz(end, timezone)}`;
  const transitions = allowedTransitions(appointment.status);
  const showMenu = canWrite && (transitions.length > 0 || isReschedulable(appointment.status) || Boolean(actions.onNotes));
  const muted = appointment.status === "CANCELLED" || appointment.status === "NO_SHOW";
  // What the patient owes, for the desk (roles that take payments), on visits still to happen or under way.
  const balance = muted || appointment.status === "COMPLETED" || appointment.status === "WAITLISTED" ? null : appointment.patientBalance;
  const late = isRunningLate(appointment, now);
  const next = NEXT_STATUS[appointment.status];
  const step = canWrite && next && availableTransitions(appointment, now, timezone).includes(next) ? next : null;
  const doctor = appointment.doctor?.fullName ?? "No doctor assigned";
  const what = appointment.reason ?? KIND_LABEL[appointment.kind];
  // Everything about the visit in one line, for the tooltip of a shortened entry.
  const summary = [appointment.reason, KIND_LABEL[appointment.kind], doctor, appointment.room].filter(Boolean).join(" · ");

  const menu = showMenu ? (
    <AppointmentActionsMenu appointment={appointment} timezone={timezone} pending={pending} actions={actions} />
  ) : null;

  const timeRange = (
    <>
      {formatTimeInTz(start, timezone)}
      <span className="font-normal text-muted-foreground">–{formatTimeInTz(end, timezone)}</span>
    </>
  );

  const notesBadge =
    appointment.notesCount > 0 ? (
      <button
        type="button"
        onClick={actions.onNotes ? () => actions.onNotes?.(appointment) : undefined}
        disabled={!actions.onNotes}
        aria-label={`${appointment.notesCount} dictated ${appointment.notesCount === 1 ? "note" : "notes"} on this appointment`}
        title={`${appointment.notesCount} dictated ${appointment.notesCount === 1 ? "note" : "notes"}`}
        className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground hover:bg-accent-muted hover:text-accent disabled:cursor-default"
      >
        <Mic className="h-3 w-3" aria-hidden="true" />
        {appointment.notesCount}
      </button>
    ) : null;

  const lateBadge = late ? (
    <Badge tone="danger" className="gap-1" title={appointment.status === "CHECKED_IN" ? "Checked in and still waiting" : "Past the start time and not checked in"}>
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      Late
    </Badge>
  ) : null;

  const name = (
    <Link
      href={`/dashboard/patients/${appointment.patientId}`}
      className={cn("block truncate rounded-sm text-sm font-medium hover:underline", muted && "text-muted-foreground line-through")}
    >
      {appointment.patient.fullName}
    </Link>
  );

  const cancelReason =
    appointment.cancelReason && muted ? (
      <p className="truncate text-xs text-danger" title={appointment.cancelReason}>
        {appointment.cancelReason}
      </p>
    ) : null;

  if (layout === "row") {
    const status = <AppointmentStatusBadge status={appointment.status} awaitingSince={appointment.confirmationRequestedAt} />;
    return (
      <article
        aria-label={`${time} ${appointment.patient.fullName}`}
        className={cn("flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-4 md:px-5", pending && "opacity-60")}
      >
        <div className="flex items-center justify-between gap-2 md:w-24 md:shrink-0">
          <span className="whitespace-nowrap text-sm font-medium tabular-nums">{timeRange}</span>
          {/* On a narrow screen the status sits beside the time, where the eye lands first. */}
          <span className="md:hidden">{status}</span>
        </div>
        <div className="min-w-0 flex-1">
          {name}
          <p className="truncate text-xs text-muted-foreground" title={summary}>
            <span className={muted ? undefined : "text-foreground/80"}>{what}</span>
            {appointment.reason ? ` · ${KIND_LABEL[appointment.kind]}` : ""} · {doctor}
            {appointment.room ? ` · ${appointment.room}` : ""}
          </p>
          {cancelReason}
        </div>
        {/* On a narrow screen the marks and the actions share a line (and wrap); from a tablet up each is a column of the row. */}
        <div className="flex flex-wrap items-center gap-2 md:contents">
          <div className="flex flex-wrap items-center gap-1.5 md:shrink-0 md:justify-end">
            {notesBadge}
            <BalanceChip balance={balance} />
            {lateBadge}
            <span className="hidden md:inline-flex">{status}</span>
          </div>
          {canWrite ? (
            <div className="ml-auto flex items-center gap-1 md:ml-0 md:w-44 md:shrink-0 md:justify-end">
              {step ? (
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => actions.onTransition(appointment, step)}>
                  {transitionLabel(appointment.status, step)}
                </Button>
              ) : null}
              {menu}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  return (
    <article aria-label={`${time} ${appointment.patient.fullName}`} className={cn("min-w-0 px-2.5 py-2", pending && "opacity-60")}>
      <div className="flex items-center justify-between gap-1">
        <span className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs font-medium tabular-nums">
          <span>{timeRange}</span>
          {notesBadge}
        </span>
        {menu}
      </div>
      {name}
      <p className="truncate text-xs text-muted-foreground" title={summary}>
        {showDoctor ? doctor : what}
      </p>
      {cancelReason}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <AppointmentStatusBadge plain status={appointment.status} awaitingSince={appointment.confirmationRequestedAt} />
        {late ? (
          <span className="flex items-center gap-1 text-xs font-medium text-danger">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
            Late
          </span>
        ) : null}
      </div>
      {balance != null && balance !== 0 ? (
        <div className="mt-1">
          <BalanceChip balance={balance} />
        </div>
      ) : null}
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
          className="h-7 w-7 shrink-0 text-muted-foreground"
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

"use client";

import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CalendarClock, Loader2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AppointmentDTO } from "@/modules/appointments/dto";
import {
  allowedTransitions,
  isReschedulable,
  transitionLabel,
  type AppointmentStatus,
} from "@/modules/appointments/transitions";
import { AppointmentStatusBadge } from "./appointment-status";

export interface AppointmentActions {
  onTransition: (appointment: AppointmentDTO, status: AppointmentStatus) => void;
  onCancel: (appointment: AppointmentDTO) => void;
  onReschedule: (appointment: AppointmentDTO) => void;
}

const DESTRUCTIVE: readonly AppointmentStatus[] = ["CANCELLED", "NO_SHOW"];

/**
 * One booking on the schedule: time range, patient (linked to their record),
 * doctor, reason, status and — for writers — a menu with exactly the moves
 * the state machine allows from its current status.
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
  const showMenu = canWrite && (transitions.length > 0 || isReschedulable(appointment.status));
  const muted = appointment.status === "CANCELLED" || appointment.status === "NO_SHOW";

  const menu = showMenu ? (
    <AppointmentActionsMenu appointment={appointment} pending={pending} actions={actions} />
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
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <AppointmentStatusBadge status={appointment.status} />
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
      {/* Wraps in narrow week columns: the badge and menu drop to a second line instead of overflowing the card. */}
      <div className="flex flex-wrap items-center justify-between gap-x-1 gap-y-1">
        <span className="whitespace-nowrap font-mono text-xs tabular-nums">{time}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <AppointmentStatusBadge status={appointment.status} />
          {menu}
        </div>
      </div>
      <div className="mt-1 space-y-0.5">{details}</div>
    </article>
  );
}

function AppointmentActionsMenu({
  appointment,
  pending,
  actions,
}: {
  appointment: AppointmentDTO;
  pending: boolean;
  actions: AppointmentActions;
}) {
  const transitions = allowedTransitions(appointment.status);
  const regular = transitions.filter((s) => !DESTRUCTIVE.includes(s));
  const destructive = transitions.filter((s) => DESTRUCTIVE.includes(s));
  const reschedulable = isReschedulable(appointment.status);

  function choose(status: AppointmentStatus) {
    if (status === "CANCELLED") actions.onCancel(appointment);
    else actions.onTransition(appointment, status);
  }

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
          className="z-50 min-w-[12rem] rounded-lg border border-border bg-card p-1 text-sm shadow-lg animate-fade-in"
        >
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
          {destructive.length && (regular.length || reschedulable) ? (
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
          ) : null}
          {destructive.map((status) => (
            <MenuItem key={status} onSelect={() => choose(status)} tone="danger">
              {transitionLabel(appointment.status, status)}
            </MenuItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
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

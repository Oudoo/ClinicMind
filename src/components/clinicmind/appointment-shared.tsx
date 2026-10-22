"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { ApiError, apiFetch } from "@/lib/http";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import type { AppointmentConflictDTO } from "@/modules/appointments/dto";
import { STATUS_LABEL, type AppointmentStatus } from "@/modules/appointments/transitions";

/** Pieces shared by the booking dialogs and the calendar. */

export interface StaffOption {
  id: string;
  fullName: string;
  role: string;
}

/** Doctors of the tenant, fetched from `/api/staff` once `enabled` is true. */
export function useDoctors(enabled: boolean): { doctors: StaffOption[] | null; error: string | null } {
  const [state, setState] = useState<{ doctors: StaffOption[] | null; error: string | null }>({
    doctors: null,
    error: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<{ staff: StaffOption[] }>("/api/staff?role=DOCTOR")
      .then((res) => {
        if (!cancelled) setState({ doctors: res.staff, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ doctors: [], error: "Could not load the doctor list." });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** The conflicting slots carried by a 409 `conflict` response, or null for any other error. */
export function conflictsFrom(err: unknown): AppointmentConflictDTO[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== "conflict") return null;
  const body = err.body as { conflicts?: AppointmentConflictDTO[] } | null;
  return body?.conflicts ?? [];
}

export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === "conflict") return "That slot is already taken by another booking.";
    if (err.status === 409 && err.code === "invalid_transition") {
      const body = err.body as { from?: AppointmentStatus; to?: AppointmentStatus };
      const from = body.from ? STATUS_LABEL[body.from] : "its current status";
      const to = body.to ? STATUS_LABEL[body.to].toLowerCase() : "that status";
      return `An appointment that is ${from.toLowerCase()} cannot be moved to ${to}. Reload to see its latest status.`;
    }
    if (err.status === 409 && err.code === "not_reschedulable") {
      return "This appointment can no longer be rescheduled.";
    }
    if (err.status === 404) return "This appointment no longer exists.";
    return err.message;
  }
  return "Could not reach the server. Please try again.";
}

/** Lists the bookings a requested slot overlaps and offers the waitlist. */
export function ConflictNotice({
  conflicts,
  timezone,
  onWaitlist,
  busy = false,
}: {
  conflicts: AppointmentConflictDTO[];
  timezone: string;
  onWaitlist?: () => void;
  busy?: boolean;
}) {
  return (
    <Alert tone="danger" className="space-y-2">
      <p className="font-medium">That slot is already taken.</p>
      {conflicts.length ? (
        <ul className="space-y-1 text-xs">
          {conflicts.map((c) => {
            const start = new Date(c.startsAt);
            const end = new Date(c.endsAt);
            return (
              <li key={c.id} className="flex flex-wrap gap-x-2">
                <span className="font-mono tabular-nums">
                  {formatDateInTz(start, timezone, { day: "2-digit", month: "short" })} {formatTimeInTz(start, timezone)}–
                  {formatTimeInTz(end, timezone)}
                </span>
                <span>
                  {c.doctor?.fullName ?? "No doctor"}
                  {c.room ? ` · ${c.room}` : ""} · {c.patient.fullName}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {onWaitlist ? (
        <div className="pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onWaitlist} disabled={busy}>
            Waitlist instead
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

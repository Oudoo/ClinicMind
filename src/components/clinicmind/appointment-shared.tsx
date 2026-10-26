"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { ApiError, apiFetch } from "@/lib/http";
import { formatDateInTz, formatTimeInTz } from "@/lib/time";
import type { AppointmentConflictDTO, FreeSlotsDTO, SlotSuggestionDTO } from "@/modules/appointments/dto";
import { STATUS_LABEL, type AppointmentStatus } from "@/modules/appointments/transitions";

/** Pieces shared by the booking dialogs, the calendar and the next-appointment button. */

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

// ── Free slots ───────────────────────────────────────────────────────────────

export interface FreeSlotsParams {
  doctorId?: string;
  room?: string;
  /** `YYYY-MM-DD` on the clinic clock. */
  date: string;
  duration: number;
  excludeId?: string;
  /** Suggestions start after this instant (ISO). */
  after?: string;
}

export function freeSlotsUrl(p: FreeSlotsParams): string {
  const params = new URLSearchParams({ date: p.date, duration: String(p.duration) });
  if (p.doctorId) params.set("doctorId", p.doctorId);
  if (p.room) params.set("room", p.room);
  if (p.excludeId) params.set("excludeId", p.excludeId);
  if (p.after) params.set("after", p.after);
  return `/api/appointments/free-slots?${params.toString()}`;
}

/**
 * The day's grid for a doctor and/or room from `GET /api/appointments/free-slots`,
 * refetched (debounced) whenever the parameters change. Nothing is fetched until
 * a doctor or a room is chosen.
 */
export function useFreeSlots(params: FreeSlotsParams | null): { data: FreeSlotsDTO | null; loading: boolean; error: string | null } {
  const key = params && (params.doctorId || params.room) && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? freeSlotsUrl(params) : null;
  const url = useDebouncedValue(key, 150);
  const [state, setState] = useState<{ url: string | null; data: FreeSlotsDTO | null; error: string | null }>({ url: null, data: null, error: null });
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    apiFetch<FreeSlotsDTO>(url, { signal: controller.signal })
      .then((data) => setState({ url, data, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setState({ url, data: null, error: err instanceof Error ? err.message : "Could not load the free slots." });
      });
    return () => controller.abort();
  }, [url]);
  if (!url) return { data: null, loading: false, error: null };
  const current = state.url === url;
  return { data: current ? state.data : null, loading: !current, error: current ? state.error : null };
}

// ── Conflicts ────────────────────────────────────────────────────────────────

export interface ConflictInfo {
  /** `slot`: the doctor or the room is taken; `patient`: the patient already has a booking then. */
  kind: "slot" | "patient";
  conflicts: AppointmentConflictDTO[];
}

/** The 409 `conflict` / `patient_conflict` payload, or null for any other error. */
export function conflictInfo(err: unknown): ConflictInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code !== "conflict" && err.code !== "patient_conflict") return null;
  const body = err.body as { conflicts?: AppointmentConflictDTO[] } | null;
  return { kind: err.code === "conflict" ? "slot" : "patient", conflicts: body?.conflicts ?? [] };
}

/** The conflicting slots carried by a 409 `conflict` response, or null for any other error. */
export function conflictsFrom(err: unknown): AppointmentConflictDTO[] | null {
  const info = conflictInfo(err);
  return info && info.kind === "slot" ? info.conflicts : null;
}

export function describeApiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === "conflict") return "That slot is already taken by another booking.";
    if (err.status === 409 && err.code === "patient_conflict") return "This patient already has an appointment at that time.";
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

/** "Book 11:30 instead", or with the day when the suggestion is not on `dayKey`. */
export function suggestionLabel(s: SlotSuggestionDTO, timezone: string, dayKey: string): string {
  const start = new Date(s.startsAt);
  const time = formatTimeInTz(start, timezone);
  if (s.date === dayKey) return `Book ${time} instead`;
  return `Book ${formatDateInTz(start, timezone, { weekday: "short", day: "2-digit", month: "short" })} ${time} instead`;
}

/**
 * Lists the bookings a requested slot overlaps and the ways out: the next free
 * slots as one-tap buttons, the waitlist, or (for a patient overlap) booking anyway.
 */
export function ConflictNotice({
  conflict,
  timezone,
  dayKey,
  suggestions,
  onPickSuggestion,
  onWaitlist,
  onOverride,
  busy = false,
}: {
  conflict: ConflictInfo;
  timezone: string;
  /** The requested day (`YYYY-MM-DD`), so same-day suggestions read as plain times. */
  dayKey: string;
  /** null while loading, [] when the week ahead is full. */
  suggestions?: SlotSuggestionDTO[] | null;
  onPickSuggestion?: (s: SlotSuggestionDTO) => void;
  onWaitlist?: () => void;
  onOverride?: () => void;
  busy?: boolean;
}) {
  const patient = conflict.kind === "patient";
  return (
    <Alert tone="danger" className="space-y-2">
      <p className="font-medium">
        {patient ? "This patient already has an appointment at that time." : "That slot is already taken."}
      </p>
      {conflict.conflicts.length ? (
        <ul className="space-y-1 text-xs">
          {conflict.conflicts.map((c) => {
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
                  {c.room ? ` · ${c.room}` : ""} · {c.patient.fullName} · {STATUS_LABEL[c.status].toLowerCase()}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {onPickSuggestion ? (
        <div className="space-y-1 pt-1">
          <p className="text-xs">{suggestions === null || suggestions === undefined ? "Looking for the next free slots…" : suggestions.length ? "Next free slots:" : "No free slot in the coming week."}</p>
          {suggestions?.length ? (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map((s) => (
                <Button key={s.startsAt} type="button" variant="outline" size="sm" onClick={() => onPickSuggestion(s)} disabled={busy}>
                  {suggestionLabel(s, timezone, dayKey)}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {onWaitlist || onOverride ? (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {onWaitlist ? (
            <Button type="button" variant="outline" size="sm" onClick={onWaitlist} disabled={busy}>
              Add to waitlist
            </Button>
          ) : null}
          {patient && onOverride ? (
            <Button type="button" variant="ghost" size="sm" onClick={onOverride} disabled={busy}>
              Book anyway
            </Button>
          ) : null}
        </div>
      ) : null}
    </Alert>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { ApiError, apiFetch } from "@/lib/http";
import { formatDateInTz, formatTimeInTz, fromDateKey } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AppointmentConflictDTO, ConfirmationRequestDTO, FreeSlotsDTO, SlotSuggestionDTO } from "@/modules/appointments/dto";
import { clinicDayLabel, closedDaysLabel, describeHours, isClosedDay } from "@/modules/appointments/rules";
import { STATUS_LABEL, type AppointmentKind, type AppointmentStatus, type WorkingHours } from "@/modules/appointments/transitions";

/** Pieces shared by the booking dialogs, the calendar and the next-appointment button. */

/**
 * "Mon 02 Nov" on the clinic clock. Built from the numeric parts rather than
 * `Intl`'s weekday format, whose punctuation differs between ICU versions
 * ("Mon, 02 Nov" in Node, "Mon 02 Nov" in Chromium): text rendered on the
 * server and hydrated in the browser must be identical.
 */
export const shortDayLabel = clinicDayLabel;

export interface StaffOption {
  id: string;
  fullName: string;
  role: string;
}

/** "Heba Mostafa (nurse)" for nurse-led sessions, the plain name for clinicians. */
export function staffLabel(s: StaffOption): string {
  return s.role === "NURSE" ? `${s.fullName} (nurse)` : s.fullName;
}

/**
 * Who a booking of `kind` can be made with, from `/api/appointments/clinicians`
 * once `enabled` is true: the clinicians, plus the nurses for a procedure.
 * Refetched when the kind changes.
 */
export function useDoctors(enabled: boolean, kind?: AppointmentKind): { doctors: StaffOption[] | null; error: string | null } {
  const url = `/api/appointments/clinicians${kind ? `?kind=${kind}` : ""}`;
  const [state, setState] = useState<{ url: string | null; doctors: StaffOption[] | null; error: string | null }>({
    url: null,
    doctors: null,
    error: null,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    apiFetch<{ staff: StaffOption[] }>(url)
      .then((res) => {
        if (!cancelled) setState({ url, doctors: res.staff, error: null });
      })
      .catch(() => {
        if (!cancelled) setState({ url, doctors: [], error: "Could not load the doctor list." });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, url]);
  // Keep showing the previous list while another kind's list loads.
  return { doctors: state.doctors, error: state.error };
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

// ── Clock rules (past bookings, opening hours) ───────────────────────────────

export interface TimeRuleInfo {
  code: "in_the_past" | "outside_hours";
  message: string;
  /** The caller is an owner who may resend with `allowPast` / `allowOutsideHours`. */
  overridable: boolean;
}

/** The 422 `in_the_past` / `outside_hours` payload, or null for any other error. */
export function timeRuleInfo(err: unknown): TimeRuleInfo | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  if (err.code !== "in_the_past" && err.code !== "outside_hours") return null;
  const body = err.body as { overridable?: boolean } | null;
  return { code: err.code, message: err.message, overridable: Boolean(body?.overridable) };
}

/**
 * A booking refused by the clock: the server's explanation and, for the
 * owner, a deliberate override ("Back-enter anyway" / "Book outside the hours").
 */
export function TimeRuleNotice({ rule, onOverride, busy = false }: { rule: TimeRuleInfo; onOverride?: () => void; busy?: boolean }) {
  return (
    <Alert tone="danger" className="space-y-2" data-testid="booking-time-refusal">
      <p className="font-medium">{rule.code === "in_the_past" ? "That time has passed." : "The clinic is not open then."}</p>
      <p className="text-xs">{rule.message}</p>
      {rule.overridable && onOverride ? (
        <div className="pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onOverride} disabled={busy}>
            {rule.code === "in_the_past" ? "Back-enter anyway (owner)" : "Book outside the hours (owner)"}
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}

/**
 * The hint under a booking date: the opening hours and the closed days
 * ("Open Sat–Thu 10:00–20:00 · Friday closed"), or a warning when the chosen
 * day is one of them.
 */
export function OpeningHoursHint({ date, hours, timezone, className }: { date: string; hours: WorkingHours; timezone: string; className?: string }) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? fromDateKey(date, timezone) : null;
  const closedLabel = closedDaysLabel(hours);
  if (day && isClosedDay(day, hours, timezone)) {
    return (
      <span className={cn("text-warning", className)} data-testid="closed-day-hint">
        Closed on {formatDateInTz(day, timezone, { weekday: "long" })}s · open {describeHours(hours)}
      </span>
    );
  }
  return (
    <span className={className}>
      Open {describeHours(hours)}
      {closedLabel ? ` · ${closedLabel}` : ""}
    </span>
  );
}

/**
 * One line for the toast after a move: whether the patient was asked to
 * confirm the new time, and what reception does when they could not be.
 */
export function describeConfirmation(confirmation: ConfirmationRequestDTO | null | undefined, patientName: string): string | null {
  if (!confirmation) return null;
  const first = patientName.trim().split(/\s+/)[0] || patientName;
  if (confirmation.requested) {
    return confirmation.delivery === "LOGGED"
      ? `The request to confirm is on ${first}'s conversation: no WhatsApp channel is connected, so send it from the clinic's phone.`
      : `${first} was asked on WhatsApp to confirm the new time.`;
  }
  if (confirmation.reason === "no_phone") return `No mobile number on file: call ${first} to confirm the new time.`;
  return `WhatsApp could not deliver the request${confirmation.reason && confirmation.reason !== "error" ? ` (${confirmation.reason})` : ""}: call ${first} to confirm the new time.`;
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
  return `Book ${shortDayLabel(start, timezone)} ${time} instead`;
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

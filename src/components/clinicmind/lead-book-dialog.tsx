"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { ApiError, apiFetch, fieldErrors } from "@/lib/http";
import { dateKeyInTz, formatDateInTz, formatTimeInTz, fromLocalInput } from "@/lib/time";
import { cn } from "@/lib/utils";
import { crmErrorMessage, type StaffOption } from "./lead-shared";

interface FreeSlotsResponse {
  closed: boolean;
  hours: { start: string; end: string; days: number[] };
  slots: { startsAt: string; endsAt: string; free: boolean; past?: boolean }[];
}

const DURATIONS = [15, 20, 30, 45, 60];

/**
 * Book the lead's consultation: doctor, day, length, then one of the day's
 * free starts (from the appointments service, on the clinic clock) or a typed
 * time. A lead without a patient record gets one as part of the booking.
 */
export function LeadBookDialog({
  lead,
  doctors,
  timezone,
  defaultReason,
  onOpenChange,
  onDone,
}: {
  lead: { id: string; fullName: string; patientId: string | null };
  doctors: StaffOption[];
  timezone: string;
  defaultReason: string;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const id = useId();
  const { toast } = useToast();
  const [doctorId, setDoctorId] = useState(doctors.length === 1 ? (doctors[0]?.id ?? "") : "");
  const [date, setDate] = useState(() => dateKeyInTz(new Date(), timezone));
  const [duration, setDuration] = useState(30);
  const [time, setTime] = useState("");
  const [room, setRoom] = useState("");
  const [reason, setReason] = useState(defaultReason);
  const [slots, setSlots] = useState<{ key: string; data: FreeSlotsResponse | null; error: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const slotKey = doctorId && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${doctorId}|${date}|${duration}|${reload}` : null;
  useEffect(() => {
    if (!slotKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ doctorId, date, duration: String(duration) });
    apiFetch<FreeSlotsResponse>(`/api/appointments/free-slots?${params.toString()}`, { signal: controller.signal })
      .then((data) => setSlots({ key: slotKey, data, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setSlots({ key: slotKey, data: null, error: err instanceof ApiError ? err.message : "Could not load the free slots." });
      });
    return () => controller.abort();
  }, [slotKey, doctorId, date, duration]);

  const current = slots && slots.key === slotKey ? slots : null;
  const free = current?.data?.slots.filter((s) => s.free && !s.past) ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (!doctorId) next.doctorId = "Choose a doctor.";
    const start = time ? fromLocalInput(`${date}T${time}`, timezone) : null;
    if (!start) next.startsAt = "Pick a free slot or type a time.";
    setIssues(next);
    if (!start || !doctorId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leads/${lead.id}/book`, {
        method: "POST",
        body: { doctorId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration * 60_000).toISOString(), room, reason },
      });
      toast({
        title: `Consultation booked for ${lead.fullName}`,
        description: `${formatDateInTz(start, timezone, { weekday: "short", day: "2-digit", month: "short" })} ${formatTimeInTz(start, timezone)}${lead.patientId ? "" : " · patient record created"}`,
        tone: "success",
      });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length) {
        setIssues(fields);
        setError("Please check the highlighted fields.");
      } else {
        setError(crmErrorMessage(err));
        if (err instanceof ApiError && err.status === 409) setReload((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`Book a consultation for ${lead.fullName}`} description={`Times on the clinic clock (${timezone}).`} className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Doctor" htmlFor={`${id}-doctor`} hint={hint("doctorId")}>
              <Select id={`${id}-doctor`} value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setTime(""); }} aria-invalid={issues.doctorId ? true : undefined}>
                <option value="">{doctors.length ? "Choose a doctor" : "No doctors"}</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.fullName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Date" htmlFor={`${id}-date`}>
              <Input id={`${id}-date`} type="date" value={date} min={dateKeyInTz(new Date(), timezone)} onChange={(e) => { setDate(e.target.value); setTime(""); }} />
            </Field>
            <Field label="Duration" htmlFor={`${id}-duration`}>
              <Select id={`${id}-duration`} value={String(duration)} onChange={(e) => { setDuration(Number(e.target.value)); setTime(""); }}>
                {DURATIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <section aria-label="Free slots" className="space-y-2 rounded-lg border border-border p-3">
            <p className="text-sm font-medium">Free slots</p>
            {!slotKey ? (
              <p className="text-xs text-muted-foreground">Choose a doctor to see the day's free slots.</p>
            ) : !current ? (
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6" aria-busy="true">
                {Array.from({ length: 12 }, (_, i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : current.error ? (
              <p className="text-xs text-danger">{current.error}</p>
            ) : current.data?.closed ? (
              <p className="text-xs text-muted-foreground">The clinic is closed on this day. Pick another date.</p>
            ) : free.length ? (
              <div className="grid max-h-48 grid-cols-4 gap-1.5 overflow-y-auto sm:grid-cols-6" role="listbox" aria-label="Free start times">
                {free.map((s) => {
                  const label = formatTimeInTz(new Date(s.startsAt), timezone);
                  const selected = time === label;
                  return (
                    <button
                      key={s.startsAt}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => setTime(label)}
                      className={cn(
                        "h-9 rounded-md border font-mono text-xs tabular-nums transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selected ? "border-accent bg-accent text-accent-foreground" : "border-border bg-card hover:bg-muted",
                      )}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing free on this day for this doctor. Try another day.</p>
            )}
          </section>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Start" htmlFor={`${id}-time`} hint={hint("startsAt", "Or type a time")}>
              <Input id={`${id}-time`} type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} aria-invalid={issues.startsAt ? true : undefined} />
            </Field>
            <Field label="Room" htmlFor={`${id}-room`} hint={hint("room", "Optional")}>
              <Input id={`${id}-room`} value={room} onChange={(e) => setRoom(e.target.value)} maxLength={60} placeholder="Room 1" />
            </Field>
            <Field label="Reason" htmlFor={`${id}-reason`} hint={hint("reason")}>
              <DictationField multiline={false} onDictated={setReason} disabled={busy}>
                <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
              </DictationField>
            </Field>
          </div>
          {lead.patientId ? null : <p className="text-xs text-muted-foreground">This lead has no patient record yet: booking creates it from the lead's details.</p>}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Booking…" : time ? `Book ${time}` : "Book consultation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

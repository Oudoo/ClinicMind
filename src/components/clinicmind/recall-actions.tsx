"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { BellOff, CalendarPlus, ChevronDown, MessageCircle, NotebookPen, Phone, PhoneOff, RotateCcw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { ApiError, apiFetch, fieldErrors } from "@/lib/http";
import { addDays, dateKeyInTz, formatDateInTz, formatTimeInTz, fromLocalInput } from "@/lib/time";
import { cn } from "@/lib/utils";
import { CALL_OUTCOMES, DECLINE_REASONS, STAFF_DECLINE_REASONS, type CallOutcome, type DeclineReason } from "@/modules/recalls/constants";
import type { RecallDTO } from "@/modules/recalls/dto";
import { recallErrorMessage } from "./recall-shared";

type Dialogs = null | "call" | "book" | "snooze" | "decline" | "unreachable" | "note" | "reopen";

const item =
  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

const WAITING = ["OPEN", "CONTACTED", "SNOOZED"];
const CLOSED = ["DONE", "DECLINED", "UNREACHABLE"];

/**
 * Working one recall: the WhatsApp template in one tap, a call's outcome,
 * booking into a free slot, and the rest (snooze, decline with the reason,
 * unreachable, a note, reopen) from "More". Every action is logged on the
 * recall; the page refreshes after each one.
 */
export function RecallActions({ recall, timezone, className }: { recall: RecallDTO; timezone: string; className?: string }) {
  const router = useRouter();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [sending, setSending] = useState(false);
  const waiting = WAITING.includes(recall.status);
  const closed = CLOSED.includes(recall.status);
  const who = recall.patient.fullName;

  const done = () => {
    setDialog(null);
    router.refresh();
  };

  async function sendTemplate() {
    if (sending) return;
    setSending(true);
    try {
      const res = await apiFetch<{ message: { delivery: string; failedReason: string | null } }>(`/api/recalls/${recall.id}/actions`, { method: "POST", body: { action: "message" } });
      const d = res.message.delivery;
      toast(
        d === "FAILED"
          ? { title: `Not delivered to ${who}`, description: res.message.failedReason ?? "The message did not go: call instead.", tone: "danger" }
          : d === "LOGGED"
            ? { title: `Message logged for ${who}`, description: "No WhatsApp number is connected yet: it is on the patient's conversation.", tone: "info" }
            : { title: `Sent to ${who} on WhatsApp`, description: "Their reply comes to the inbox.", tone: "success" },
      );
      router.refresh();
    } catch (err) {
      toast({ title: "Could not send the message", description: recallErrorMessage(err), tone: "danger" });
      if (err instanceof ApiError && err.status === 409) router.refresh();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {waiting ? (
        <>
          <Button size="sm" variant="outline" onClick={() => void sendTemplate()} disabled={sending || !recall.canMessage} aria-label={`Send the WhatsApp template to ${who}`} title={recall.canMessage ? "Send the recall message on WhatsApp" : "No WhatsApp number or phone"}>
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {sending ? "Sending…" : "WhatsApp"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setDialog("call")} aria-label={`Log a call to ${who}`}>
            <Phone className="h-4 w-4" aria-hidden="true" />
            Log call
          </Button>
          <Button size="sm" onClick={() => setDialog("book")} aria-label={`Book ${who}`}>
            <CalendarPlus className="h-4 w-4" aria-hidden="true" />
            Book
          </Button>
        </>
      ) : recall.status === "BOOKED" ? (
        <Button size="sm" variant="outline" onClick={() => setDialog("call")} aria-label={`Log a call to ${who}`}>
          <Phone className="h-4 w-4" aria-hidden="true" />
          Log call
        </Button>
      ) : null}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`More for ${who}'s recall`}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            More
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-50 min-w-[12rem] rounded-lg border border-border bg-card p-1 shadow-lg animate-fade-in">
            {waiting ? (
              <>
                <DropdownMenu.Item className={item} onSelect={() => setDialog("snooze")}>
                  <BellOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Snooze…
                </DropdownMenu.Item>
                <DropdownMenu.Item className={item} onSelect={() => setDialog("unreachable")}>
                  <PhoneOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Unreachable…
                </DropdownMenu.Item>
                <DropdownMenu.Item className={cn(item, "text-danger data-[highlighted]:bg-danger/5")} onSelect={() => setDialog("decline")}>
                  <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  Declined…
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
              </>
            ) : null}
            {closed && recall.status !== "DONE" ? (
              <DropdownMenu.Item className={item} onSelect={() => setDialog("reopen")}>
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                Reopen…
              </DropdownMenu.Item>
            ) : null}
            <DropdownMenu.Item className={item} onSelect={() => setDialog("note")}>
              <NotebookPen className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              Add a note…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {dialog === "call" ? <CallDialog recall={recall} timezone={timezone} onOpenChange={(o) => !o && setDialog(null)} onDone={done} /> : null}
      {dialog === "book" ? <BookRecallDialog recall={recall} timezone={timezone} onOpenChange={(o) => !o && setDialog(null)} onDone={done} /> : null}
      {dialog && ["snooze", "decline", "unreachable", "note", "reopen"].includes(dialog) ? (
        <SimpleActionDialog action={dialog as SimpleAction} recall={recall} timezone={timezone} onOpenChange={(o) => !o && setDialog(null)} onDone={done} />
      ) : null}
    </div>
  );
}

// ── A call ───────────────────────────────────────────────────────────────────

function CallDialog({ recall, timezone, onOpenChange, onDone }: { recall: RecallDTO; timezone: string; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const id = useId();
  const { toast } = useToast();
  const booked = recall.status === "BOOKED";
  const outcomes = CALL_OUTCOMES.filter((o) => !booked || (o.key !== "declined" && o.key !== "wrong_number"));
  const [outcome, setOutcome] = useState<CallOutcome | "">("");
  const [note, setNote] = useState("");
  const [callBackOn, setCallBackOn] = useState(() => dateKeyInTz(addDays(new Date(), 1, timezone), timezone));
  const [reason, setReason] = useState<DeclineReason | "">("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!outcome) return setIssues({ outcome: "What came of the call?" });
    if (outcome === "declined" && !reason) return setIssues({ reason: "Why did they decline?" });
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/recalls/${recall.id}/actions`, {
        method: "POST",
        body: { action: "call", outcome, note, ...(outcome === "call_back" ? { callBackOn } : {}), ...(outcome === "declined" ? { reason } : {}) },
      });
      toast({ title: `Call logged: ${CALL_OUTCOMES.find((o) => o.key === outcome)?.label}`, description: recall.patient.fullName, tone: "success" });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : recallErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`Call ${recall.patient.fullName}`} description={recall.label}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {recall.patient.phone || recall.patient.whatsapp ? (
            <a href={`tel:${recall.patient.phone ?? recall.patient.whatsapp}`} className="inline-flex items-center gap-2 font-mono text-sm text-accent hover:underline">
              <Phone className="h-4 w-4" aria-hidden="true" />
              {recall.patient.phone ?? recall.patient.whatsapp}
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">No phone number on record.</p>
          )}
          <fieldset className="space-y-2">
            <legend className="data-label">Outcome</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
              {outcomes.map((o) => (
                <label key={o.key} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm transition-colors", outcome === o.key ? "border-accent bg-accent/5" : "border-border hover:bg-muted")}>
                  <input type="radio" name={`${id}-outcome`} value={o.key} checked={outcome === o.key} onChange={() => setOutcome(o.key)} className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--accent))]" />
                  <span>
                    <span className="block font-medium">{o.label}</span>
                    <span className="block text-xs text-muted-foreground">{o.hint}</span>
                  </span>
                </label>
              ))}
            </div>
            {issues.outcome ? <p className="text-xs text-danger">{issues.outcome}</p> : null}
          </fieldset>
          {outcome === "call_back" ? (
            <Field label="Call back on" htmlFor={`${id}-on`} hint={issues.callBackOn ? <span className="text-danger">{issues.callBackOn}</span> : undefined}>
              <Input id={`${id}-on`} type="date" value={callBackOn} min={dateKeyInTz(new Date(), timezone)} onChange={(e) => setCallBackOn(e.target.value)} />
            </Field>
          ) : null}
          {outcome === "declined" ? <ReasonSelect id={`${id}-reason`} value={reason} onChange={setReason} issue={issues.reason} /> : null}
          <Field label="Note" htmlFor={`${id}-note`} hint={issues.note ? <span className="text-danger">{issues.note}</span> : "Optional"}>
            <DictationField onDictated={setNote} disabled={busy} patientId={recall.patient.id}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Log the call"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReasonSelect({ id, value, onChange, issue }: { id: string; value: DeclineReason | ""; onChange: (v: DeclineReason) => void; issue?: string }) {
  return (
    <Field label="Why they declined" htmlFor={id} hint={issue ? <span className="text-danger">{issue}</span> : undefined}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as DeclineReason)} aria-invalid={issue ? true : undefined}>
        <option value="">Choose a reason</option>
        {DECLINE_REASONS.filter((r) => (STAFF_DECLINE_REASONS as readonly string[]).includes(r.key)).map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

// ── Snooze, decline, unreachable, note, reopen ───────────────────────────────

type SimpleAction = "snooze" | "decline" | "unreachable" | "note" | "reopen";

const SIMPLE: Record<SimpleAction, { title: (name: string) => string; description: string; submit: string; done: string }> = {
  snooze: { title: (n) => `Snooze ${n}'s recall`, description: "Off the list until the day you choose (the patient asked to be contacted later).", submit: "Snooze", done: "Snoozed" },
  decline: { title: (n) => `${n} declined`, description: "Ends the recall with the reason.", submit: "End as declined", done: "Ended as declined" },
  unreachable: { title: (n) => `${n} is unreachable`, description: "Ends the recall: tried and could not reach the patient.", submit: "End as unreachable", done: "Ended as unreachable" },
  note: { title: () => "Add a note", description: "Kept on the recall's log.", submit: "Add the note", done: "Note added" },
  reopen: { title: (n) => `Reopen ${n}'s recall`, description: "Back on the list from today.", submit: "Reopen", done: "Reopened" },
};

function SimpleActionDialog({ action, recall, timezone, onOpenChange, onDone }: { action: SimpleAction; recall: RecallDTO; timezone: string; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const id = useId();
  const { toast } = useToast();
  const copy = SIMPLE[action];
  const [note, setNote] = useState("");
  const [until, setUntil] = useState(() => dateKeyInTz(addDays(new Date(), 14, timezone), timezone));
  const [reason, setReason] = useState<DeclineReason | "">("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (action === "decline" && !reason) return setIssues({ reason: "Why did they decline?" });
    if (action === "note" && !note.trim()) return setIssues({ note: "Write the note." });
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/recalls/${recall.id}/actions`, {
        method: "POST",
        body: { action, note, ...(action === "snooze" ? { until } : {}), ...(action === "decline" ? { reason } : {}) },
      });
      toast({ title: copy.done, description: recall.patient.fullName, tone: "success" });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : recallErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={copy.title(recall.patient.fullName)} description={copy.description}>
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          {action === "snooze" ? (
            <Field label="Until" htmlFor={`${id}-until`} hint={issues.until ? <span className="text-danger">{issues.until}</span> : undefined}>
              <Input id={`${id}-until`} type="date" value={until} min={dateKeyInTz(addDays(new Date(), 1, timezone), timezone)} onChange={(e) => setUntil(e.target.value)} />
            </Field>
          ) : null}
          {action === "decline" ? <ReasonSelect id={`${id}-reason`} value={reason} onChange={setReason} issue={issues.reason} /> : null}
          <Field label="Note" htmlFor={`${id}-note`} hint={issues.note ? <span className="text-danger">{issues.note}</span> : action === "note" ? undefined : reason === "other" ? "Say what the reason is" : "Optional"}>
            <DictationField onDictated={setNote} disabled={busy} patientId={recall.patient.id}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={action === "note" ? 1000 : 500} rows={2} autoFocus={action === "note"} />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant={action === "decline" || action === "unreachable" ? "danger" : "primary"} disabled={busy}>
              {busy ? "Saving…" : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Booking into a free slot ─────────────────────────────────────────────────

interface FreeSlotsResponse {
  closed: boolean;
  slots: { startsAt: string; endsAt: string; free: boolean; past?: boolean }[];
}

const VISIT_KIND: Record<string, string> = { REVIEW: "FOLLOW_UP", NEXT_SESSION: "PROCEDURE", UNBOOKED: "PROCEDURE", LAPSED: "CHECK_UP", MISSED: "FOLLOW_UP" };
const DURATIONS = [15, 20, 30, 45, 60];

/** Book the recall: a clinician, a day (its due day by default), then one of the day's free starts or a typed time. */
function BookRecallDialog({ recall, timezone, onOpenChange, onDone }: { recall: RecallDTO; timezone: string; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const id = useId();
  const { toast } = useToast();
  const [staff, setStaff] = useState<{ id: string; fullName: string }[] | null>(null);
  const [doctorId, setDoctorId] = useState("");
  const [date, setDate] = useState(() => {
    const today = dateKeyInTz(new Date(), timezone);
    const due = dateKeyInTz(new Date(recall.dueAt), timezone);
    return due > today ? due : today;
  });
  const [duration, setDuration] = useState(30);
  const [time, setTime] = useState("");
  const [room, setRoom] = useState("");
  const [reason, setReason] = useState(recall.label);
  const [slots, setSlots] = useState<{ key: string; data: FreeSlotsResponse | null; error: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ staff: { id: string; fullName: string }[] }>(`/api/appointments/clinicians?kind=${VISIT_KIND[recall.kind] ?? "FOLLOW_UP"}`, { signal: controller.signal })
      .then((res) => {
        setStaff(res.staff);
        if (res.staff.length === 1) setDoctorId(res.staff[0]!.id);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStaff([]);
      });
    return () => controller.abort();
  }, [recall.kind]);

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
    if (!doctorId) next.doctorId = "Choose who the visit is with.";
    const start = time ? fromLocalInput(`${date}T${time}`, timezone) : null;
    if (!start) next.startsAt = "Pick a free slot or type a time.";
    setIssues(next);
    if (!start || !doctorId) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/recalls/${recall.id}/book`, {
        method: "POST",
        body: { doctorId, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + duration * 60_000).toISOString(), room, reason },
      });
      toast({ title: `Booked ${recall.patient.fullName}`, description: `${formatDateInTz(start, timezone, { weekday: "short", day: "numeric", month: "short" })} ${formatTimeInTz(start, timezone)} · ${recall.label}`, tone: "success" });
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      if (Object.keys(fields).length) {
        setIssues(fields);
        setError("Please check the highlighted fields.");
      } else {
        setError(recallErrorMessage(err));
        if (err instanceof ApiError && err.status === 409) setReload((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={`Book ${recall.patient.fullName}`} description={`${recall.label} · times on the clinic clock (${timezone}).`} className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {error ? <Alert>{error}</Alert> : null}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="With" htmlFor={`${id}-doctor`} hint={hint("doctorId")}>
              <Select id={`${id}-doctor`} value={doctorId} onChange={(e) => { setDoctorId(e.target.value); setTime(""); }} aria-invalid={issues.doctorId ? true : undefined} disabled={!staff}>
                <option value="">{staff === null ? "Loading…" : staff.length ? "Choose" : "No one to book"}</option>
                {(staff ?? []).map((d) => (
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
              <p className="text-xs text-muted-foreground">Choose who the visit is with to see the day's free slots.</p>
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
              <p className="text-xs text-muted-foreground">Nothing free on this day. Try another day.</p>
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
              <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            </Field>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Booking…" : time ? `Book ${time}` : "Book"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

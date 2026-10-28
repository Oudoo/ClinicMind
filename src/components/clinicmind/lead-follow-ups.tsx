"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { apiFetch, fieldErrors } from "@/lib/http";
import { addDays, dateKeyInTz, fromLocalInput, toLocalInput, zonedParts, zonedTimeToUtc } from "@/lib/time";
import { CHANNELS, CHANNEL_LABELS, type ChannelKey } from "@/modules/crm/shared";
import { crmErrorMessage, type StaffOption } from "./lead-shared";

const QUICK_OUTCOMES = ["No answer, will try again", "Sent prices on WhatsApp", "Booked a consultation", "Asked us to call later"];

/** "Complete" on a follow-up: what happened (required), then the queue refreshes. */
export function CompleteFollowUpButton({ followUp, size = "sm" }: { followUp: { id: string; leadName: string; note: string | null }; size?: "sm" | "md" }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!outcome.trim()) {
      setError("Say what happened.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/leads/follow-ups/${followUp.id}/complete`, { method: "POST", body: { outcome } });
      toast({ title: `Follow-up done: ${followUp.leadName}`, tone: "success" });
      setOpen(false);
      setOutcome("");
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setError(fields.outcome ?? crmErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" size={size} onClick={() => setOpen(true)}>
        <Check className="h-4 w-4" />
        Complete
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={`Complete the follow-up with ${followUp.leadName}`} description={followUp.note ?? undefined}>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <div className="flex flex-wrap gap-1.5" aria-label="Quick outcomes">
              {QUICK_OUTCOMES.map((q) => (
                <button key={q} type="button" onClick={() => setOutcome(q)} className="inline-flex h-7 items-center rounded-full border border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
                  {q}
                </button>
              ))}
            </div>
            <Field label="Outcome" htmlFor={`${id}-outcome`}>
              <DictationField onDictated={setOutcome} disabled={busy}>
                <Textarea id={`${id}-outcome`} value={outcome} onChange={(e) => setOutcome(e.target.value)} maxLength={1000} className="min-h-[5rem]" autoFocus />
              </DictationField>
            </Field>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Mark done"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The next whole quarter hour on the clinic clock, `hours` from now. */
function inHours(hours: number, timezone: string): Date {
  const t = new Date(Date.now() + hours * 3_600_000);
  const p = zonedParts(t, timezone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: p.hour, minute: Math.ceil(p.minute / 15) * 15 }, timezone);
}

function dayAt(days: number, hour: number, timezone: string): Date {
  const d = addDays(new Date(), days, timezone);
  const key = dateKeyInTz(d, timezone).split("-").map(Number) as [number, number, number];
  return zonedTimeToUtc({ year: key[0], month: key[1], day: key[2], hour }, timezone);
}

/** Schedule the next touch: when (clinic clock), how, who, and a note. */
export function AddFollowUpForm({ leadId, staff, defaultOwnerId, timezone }: { leadId: string; staff: StaffOption[]; defaultOwnerId: string | null; timezone: string }) {
  const router = useRouter();
  const id = useId();
  const { toast } = useToast();
  const [when, setWhen] = useState(() => toLocalInput(dayAt(1, 11, timezone), timezone));
  const [channel, setChannel] = useState<ChannelKey>("WHATSAPP");
  const [ownerId, setOwnerId] = useState(defaultOwnerId ?? "");
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const dueAt = fromLocalInput(when, timezone);
    if (!dueAt) {
      setIssues({ dueAt: "Enter a date and time." });
      return;
    }
    setBusy(true);
    setIssues({});
    try {
      await apiFetch(`/api/leads/${leadId}/follow-ups`, { method: "POST", body: { dueAt: dueAt.toISOString(), channel, ownerId, note } });
      toast({ title: "Follow-up scheduled", tone: "success" });
      setNote("");
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(Object.keys(fields).length ? fields : { form: crmErrorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  const presets: [string, () => Date][] = [
    ["In 2 hours", () => inHours(2, timezone)],
    ["Tomorrow 11:00", () => dayAt(1, 11, timezone)],
    ["In 3 days", () => dayAt(3, 11, timezone)],
    ["Next week", () => dayAt(7, 11, timezone)],
  ];

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-dashed border-border p-3" noValidate aria-label="Add a follow-up">
      {issues.form ? <Alert>{issues.form}</Alert> : null}
      <div className="flex flex-wrap gap-1.5" aria-label="Quick times">
        {presets.map(([label, at]) => (
          <button key={label} type="button" onClick={() => setWhen(toLocalInput(at(), timezone))} className="inline-flex h-7 items-center rounded-full border border-border px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            {label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="When" htmlFor={`${id}-when`} hint={issues.dueAt ? <span className="text-danger">{issues.dueAt}</span> : `Clinic clock (${timezone})`}>
          <Input id={`${id}-when`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} step={900} />
        </Field>
        <Field label="How" htmlFor={`${id}-channel`}>
          <Select id={`${id}-channel`} value={channel} onChange={(e) => setChannel(e.target.value as ChannelKey)}>
            {CHANNELS.filter((c) => c !== "IN_PERSON").map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Owner" htmlFor={`${id}-owner`} hint={issues.ownerId ? <span className="text-danger">{issues.ownerId}</span> : undefined}>
          <Select id={`${id}-owner`} value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">The lead's owner</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.fullName}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Note" htmlFor={`${id}-note`} hint={issues.note ? <span className="text-danger">{issues.note}</span> : undefined}>
        <DictationField onDictated={setNote} disabled={busy} multiline={false}>
          <Input id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="e.g. Send the price list and before-and-after photos" />
        </DictationField>
      </Field>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy}>
          <CalendarPlus className="h-4 w-4" />
          {busy ? "Scheduling…" : "Add follow-up"}
        </Button>
      </div>
    </form>
  );
}

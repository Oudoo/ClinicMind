"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatNumber } from "@/lib/utils";
import { addMonthsToKey, DEFAULT_REMINDER_DAYS, INSTALMENT_INTERVALS, MAX_INSTALMENTS, scheduleOf } from "@/modules/finance/instalment-schedule";
import { financeErrorMessage } from "./finance-shared";

const EVERY_LABELS: Record<number, string> = { 1: "Every month", 2: "Every 2 months", 3: "Every 3 months", 6: "Every 6 months" };

/**
 * A new instalment plan for a patient (or for their accepted treatment plan):
 * what it pays for, the total, a down payment, how many instalments and how
 * often from a first day, and how many days before each the reminder goes.
 * The schedule is shown as it will be made: equal whole pounds, the odd
 * pounds on the last.
 */
export function NewInstalmentPlanButton({
  patientId,
  patientName,
  todayKey,
  quote,
  label = "New instalment plan",
  variant = "outline",
}: {
  patientId: string;
  patientName: string;
  todayKey: string;
  /** From an accepted treatment plan: its id, heading and what was accepted. */
  quote?: { id: string; title: string; total: number };
  label?: string;
  variant?: "outline" | "primary";
}) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(quote?.title ?? "");
  const [total, setTotal] = useState(quote ? String(quote.total) : "");
  const [down, setDown] = useState("0");
  const [count, setCount] = useState("6");
  const [every, setEvery] = useState(1);
  const [firstDue, setFirstDue] = useState(addMonthsToKey(todayKey, 1));
  const [reminderDays, setReminderDays] = useState(String(DEFAULT_REMINDER_DAYS));
  const [note, setNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const num = (v: string) => Number(v.replace(/[,\s]/g, ""));
  const terms = { total: num(total), downPayment: num(down), count: num(count), everyMonths: every, firstDue, startKey: todayKey };
  const valid = Number.isInteger(terms.total) && terms.total > 0 && Number.isInteger(terms.downPayment) && terms.downPayment >= 0 && terms.downPayment < terms.total && Number.isInteger(terms.count) && terms.count >= 1 && terms.count <= MAX_INSTALMENTS && terms.total - terms.downPayment >= terms.count && /^\d{4}-\d{2}-\d{2}$/.test(firstDue);
  const schedule = valid ? scheduleOf(terms) : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: Record<string, string> = {};
    if (title.trim().length < 2) next.title = "What does it pay for?";
    if (!Number.isInteger(terms.total) || terms.total <= 0) next.total = "Whole EGP, more than zero.";
    if (!Number.isInteger(terms.downPayment) || terms.downPayment < 0) next.downPayment = "Whole EGP.";
    else if (terms.downPayment >= terms.total) next.downPayment = "Less than the total.";
    if (!Number.isInteger(terms.count) || terms.count < 1 || terms.count > MAX_INSTALMENTS) next.count = `1 to ${MAX_INSTALMENTS}.`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDue) || firstDue < todayKey) next.firstDue = "Today or later.";
    setIssues(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/instalments", {
        method: "POST",
        body: { patientId, quoteId: quote?.id, title: title.trim(), total: terms.total, downPayment: terms.downPayment, count: terms.count, everyMonths: every, firstDue, reminderDays: num(reminderDays), note: note.trim() || undefined },
      });
      toast({ tone: "success", title: "Instalment plan made", description: terms.downPayment ? "Record the down payment towards it when it is paid." : "Each payment towards it covers the next instalment." });
      setOpen(false);
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : financeErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);
  const day = (key: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`));

  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        <CalendarClock className="h-4 w-4" aria-hidden="true" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title="New instalment plan" description={`For ${patientName}. Payments recorded towards it cover the instalments in order; the patient is reminded on WhatsApp before each.`} className="max-w-xl">
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error ? <Alert>{error}</Alert> : null}
            <Field label="Pays for" htmlFor={`${id}-title`} hint={hint("title", "e.g. Hair transplant, Laser course")}>
              <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
            </Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Total (EGP)" htmlFor={`${id}-total`} hint={hint("total", "Down payment included")}>
                <Input id={`${id}-total`} inputMode="numeric" value={total} onChange={(e) => setTotal(e.target.value)} />
              </Field>
              <Field label="Down payment" htmlFor={`${id}-down`} hint={hint("downPayment", "Paid now")}>
                <Input id={`${id}-down`} inputMode="numeric" value={down} onChange={(e) => setDown(e.target.value)} />
              </Field>
              <Field label="Instalments" htmlFor={`${id}-count`} hint={hint("count")}>
                <Input id={`${id}-count`} type="number" min={1} max={MAX_INSTALMENTS} value={count} onChange={(e) => setCount(e.target.value)} />
              </Field>
              <Field label="How often" htmlFor={`${id}-every`}>
                <Select id={`${id}-every`} value={every} onChange={(e) => setEvery(Number(e.target.value))}>
                  {INSTALMENT_INTERVALS.map((n) => (
                    <option key={n} value={n}>
                      {EVERY_LABELS[n]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="First one due" htmlFor={`${id}-first`} hint={hint("firstDue")}>
                <Input id={`${id}-first`} type="date" min={todayKey} value={firstDue} onChange={(e) => setFirstDue(e.target.value)} />
              </Field>
              <Field label="Remind (days before)" htmlFor={`${id}-remind`}>
                <Select id={`${id}-remind`} value={reminderDays} onChange={(e) => setReminderDays(e.target.value)}>
                  {[0, 1, 2, 3, 5, 7].map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? "On the day" : `${n} day${n === 1 ? "" : "s"} before`}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Note (optional)" htmlFor={`${id}-note`}>
              <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className="min-h-[3.5rem]" />
            </Field>
            {schedule.length ? (
              <div className="space-y-1">
                <p className="data-label">The schedule</p>
                <ol className="max-h-48 space-y-0.5 overflow-y-auto rounded-md border border-border p-2 text-sm" data-testid="instalment-preview">
                  {schedule.map((s) => (
                    <li key={s.number} className="flex justify-between gap-3">
                      <span>{s.number === 0 ? "Down payment, today" : `${s.number}. ${day(s.dueKey)}`}</span>
                      <span className="font-mono tabular-nums">{formatNumber(s.amount)} EGP</span>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Make the plan"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, Field } from "@/components/ui/field";
import { Checkbox, Input } from "@/components/ui/input";
import { Card, SectionTitle } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import type { ReminderSettings } from "@/modules/messaging/reminder-settings";

/**
 * Settings → Reminders: what the clinic sends on its own on WhatsApp and the
 * quiet hours in which it never does. The owner edits it; everyone else
 * reads it.
 */
export function ReminderSettingsCard({ initial, canEdit, timezone }: { initial: ReminderSettings; canEdit: boolean; timezone: string }) {
  const id = useId();
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState(initial);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ReminderSettings>(key: K, value: ReminderSettings[K]) => setValues((v) => ({ ...v, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !canEdit) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await apiFetch("/api/messaging/reminders", { method: "PUT", body: values });
      toast({ title: "Reminder settings saved", tone: "success" });
      router.refresh();
    } catch (err) {
      const fields = fieldErrors(err);
      setIssues(fields);
      setError(Object.keys(fields).length ? "Please check the highlighted fields." : "Could not save the settings.");
    } finally {
      setBusy(false);
    }
  }

  const hint = (key: string, fallback?: string) => (issues[key] ? <span className="text-danger">{issues[key]}</span> : fallback);

  return (
    <Card className="space-y-4">
      <SectionTitle
        title="Reminders"
        description={`What the clinic sends on its own on WhatsApp, in the patient's language, to patients who agreed. Times on the clinic clock (${timezone}).`}
      />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <Alert>{error}</Alert> : null}
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={values.appointmentReminders} onChange={(e) => set("appointmentReminders", e.target.checked)} disabled={!canEdit} className="mt-0.5" />
            <span>
              Appointment reminders
              <span className="block text-xs text-muted-foreground">48 and 2 hours before; an unconfirmed booking is asked to reply 1 to confirm or 2 for another time.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={values.recallMessages} onChange={(e) => set("recallMessages", e.target.checked)} disabled={!canEdit} className="mt-0.5" />
            <span>
              Recall messages
              <span className="block text-xs text-muted-foreground">14 days before a recall is due, on the day and 7 days after, until it is booked. Off: reception contacts everyone due within two weeks.</span>
            </span>
          </label>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Quiet from" htmlFor={`${id}-qs`} hint={hint("quietStart", "No automatic message")}>
            <Input id={`${id}-qs`} type="time" step={900} value={values.quietStart} onChange={(e) => set("quietStart", e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Until" htmlFor={`${id}-qe`} hint={hint("quietEnd", "Messages due then wait")}>
            <Input id={`${id}-qe`} type="time" step={900} value={values.quietEnd} onChange={(e) => set("quietEnd", e.target.value)} disabled={!canEdit} />
          </Field>
          <Field label="Confirmation calls from" htmlFor={`${id}-cc`} hint={hint("confirmCallsFrom", "The day before each open day, its unconfirmed visits are listed for a call")}>
            <Input id={`${id}-cc`} type="time" step={900} value={values.confirmCallsFrom} onChange={(e) => set("confirmCallsFrom", e.target.value)} disabled={!canEdit} />
          </Field>
        </div>
        {canEdit ? (
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save reminders"}
            </Button>
          </div>
        ) : null}
      </form>
    </Card>
  );
}

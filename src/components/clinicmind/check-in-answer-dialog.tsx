"use client";

import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { ApiError, apiFetch, fieldErrors } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { CheckInDTO, EscalationDTO, TaskDTO } from "@/modules/concierge/dto";
import { expectedText, stepTitle } from "@/modules/concierge/labels";
import type { ProtocolQuestion } from "@/modules/concierge/protocols";
import type { TriageLevel } from "@/modules/concierge/triage";
import { describeConciergeError } from "@/components/clinicmind/escalation-actions";

export interface StaffAnswerResult {
  checkIn: CheckInDTO;
  triage: TriageLevel;
  escalation: EscalationDTO | null;
  callbackMinutes: number | null;
}

/**
 * "Record answer by phone": the nurse asks the step's questions on a call and
 * types what the patient said. Only what was asked is required; triage, the
 * escalation and the notifications run exactly as for the patient's own link.
 */
export function CheckInAnswerDialog({
  task,
  patientName,
  onOpenChange,
  onDone,
}: {
  task: TaskDTO;
  patientName: string;
  onOpenChange: (open: boolean) => void;
  onDone: (result: StaffAnswerResult) => void;
}) {
  const id = useId();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [satisfaction, setSatisfaction] = useState("");
  const [freeText, setFreeText] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const payload: Record<string, unknown> = {};
    for (const q of task.questions) {
      const raw = answers[q.key];
      if (raw === undefined || raw === "") continue;
      payload[q.key] = q.type === "yesno" ? raw === "yes" : q.type === "text" ? raw : Number(raw);
    }
    if (!Object.keys(payload).length && !satisfaction && !freeText.trim()) {
      setFormError("Record at least one answer, the satisfaction score or what the patient said.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<StaffAnswerResult>(`/api/concierge/tasks/${task.id}/answer`, {
        method: "POST",
        body: { answers: payload, satisfaction: satisfaction || null, freeText: freeText.trim() || undefined },
      });
      onDone(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        setErrors(fieldErrors(err));
        setFormError("Check the highlighted answers.");
      } else {
        setFormError(describeConciergeError(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title="Record answer by phone" description={`${patientName} · ${stepTitle(task.dayLabel, task.title)}`} className="max-w-xl">
        <form onSubmit={submit} className="space-y-4" noValidate>
          {formError ? <Alert>{formError}</Alert> : null}
          {task.questions.map((q) => (
            <QuestionField key={q.key} id={`${id}-${q.key}`} q={q} value={answers[q.key] ?? ""} error={errors[q.key]} onChange={(v) => set(q.key, v)} disabled={busy} />
          ))}
          {task.satisfaction ? (
            <Field label="Satisfaction (1–5)" htmlFor={`${id}-sat`} hint={errors.satisfaction}>
              <Select id={`${id}-sat`} value={satisfaction} onChange={(e) => setSatisfaction(e.target.value)} disabled={busy}>
                <option value="">Not asked</option>
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>
                    {"★".repeat(n)} {n}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field label="What the patient said" htmlFor={`${id}-free`} hint="Optional · red-flag words (bleeding, fever, can't breathe…) are triaged too">
            <DictationField onDictated={setFreeText} disabled={busy}>
              <Textarea id={`${id}-free`} value={freeText} onChange={(e) => setFreeText(e.target.value)} maxLength={2000} className="min-h-[4.5rem]" />
            </DictationField>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save answers"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QuestionField({
  id,
  q,
  value,
  error,
  onChange,
  disabled,
}: {
  id: string;
  q: ProtocolQuestion;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const expected = expectedText(q);
  const hint = (
    <span className="flex flex-wrap items-center gap-1.5">
      {error ? <span className="text-danger">{error}</span> : null}
      {expected ? <span>expected {expected}</span> : null}
      {q.highRisk || q.danger ? <Badge tone="danger">red flag</Badge> : null}
    </span>
  );
  if (q.type === "yesno") {
    return (
      <fieldset className="space-y-1.5">
        <legend className="data-label">{q.label.en}</legend>
        <div className="flex gap-2" role="radiogroup" aria-label={q.label.en}>
          {[
            ["", "Not asked"],
            ["yes", "Yes"],
            ["no", "No"],
          ].map(([v, label]) => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={value === v}
              disabled={disabled}
              onClick={() => onChange(v!)}
              className={cn(
                "h-9 flex-1 rounded-lg border text-sm transition-colors",
                value === v ? "border-accent bg-accent-muted text-accent" : "border-border hover:bg-muted",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </fieldset>
    );
  }
  if (q.type === "scale") {
    const min = q.min ?? 0;
    const max = q.max ?? 10;
    return (
      <Field label={q.label.en} htmlFor={id} hint={hint}>
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-invalid={error ? true : undefined}>
          <option value="">Not asked</option>
          {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
            <option key={n} value={n}>
              {n} / {max}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (q.type === "number") {
    return (
      <Field label={q.label.en} htmlFor={id} hint={hint}>
        <Input id={id} type="number" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} min={q.min} max={q.max} disabled={disabled} aria-invalid={error ? true : undefined} />
      </Field>
    );
  }
  return (
    <Field label={q.label.en} htmlFor={id} hint={hint}>
      <DictationField onDictated={onChange} disabled={disabled} multiline={false}>
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={500} disabled={disabled} />
      </DictationField>
    </Field>
  );
}

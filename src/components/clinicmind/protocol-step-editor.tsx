"use client";

import { useId, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";
import { dayLabel, QUESTION_TYPES, STEP_KINDS, type ProtocolQuestion, type ProtocolStep, type QuestionType, type StepKind } from "@/modules/concierge/protocols";
import { KIND_TEXT, viewLabel } from "@/modules/concierge/labels";
import { StepKindIcon } from "@/components/clinicmind/concierge-badges";

/** Validation messages keyed by path inside one step: "title", "body", "questions.0.key"… */
export type StepErrors = Record<string, string>;

const TYPE_TEXT: Record<QuestionType, string> = { scale: "0–10 scale", yesno: "Yes / no", number: "Number", text: "Text" };
const VIEW_SUGGESTIONS = ["front", "top", "donor", "back", "left", "right", "face", "area"];

const num = (v: string): number | undefined => (v.trim() === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
const str = (v: number | undefined) => (v === undefined ? "" : String(v));

function small(label: string, input: React.ReactNode, error?: string, className?: string) {
  return (
    <label className={cn("block space-y-1", className)}>
      <span className="data-label block">{label}</span>
      {input}
      {error ? <span className="block text-xs text-danger">{error}</span> : null}
    </label>
  );
}

/**
 * One protocol step: when it goes out (days + hours after the procedure),
 * its kind, title and bilingual message; check-ins carry structured questions
 * with expected ranges and the high-risk flag (and optionally the 1–5
 * satisfaction stars), photo requests name the views they want.
 */
export function StepEditor({
  step,
  index,
  count,
  errors,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  step: ProtocolStep;
  index: number;
  count: number;
  errors: StepErrors;
  disabled: boolean;
  onChange: (step: ProtocolStep) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const id = useId();
  const days = Math.floor(step.offsetHours / 24);
  const hours = Math.round(step.offsetHours - days * 24);
  const set = (patch: Partial<ProtocolStep>) => onChange({ ...step, ...patch });
  const setKind = (kind: StepKind) => {
    const next: ProtocolStep = { ...step, kind };
    if (kind !== "CHECK_IN") {
      delete next.questions;
      delete next.satisfaction;
    }
    if (kind !== "PHOTO_REQUEST") delete next.photos;
    if (kind === "CHECK_IN" && !next.questions) next.questions = [];
    if (kind === "PHOTO_REQUEST" && !next.photos) next.photos = ["front"];
    onChange(next);
  };
  const questions = step.questions ?? [];
  const setQuestion = (i: number, q: ProtocolQuestion) => set({ questions: questions.map((x, j) => (j === i ? q : x)) });

  return (
    <li className="bento-tight space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StepKindIcon kind={step.kind} className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">
            Step {index + 1} · {dayLabel(step)}
          </span>
          {questions.some((q) => q.highRisk || q.danger) ? <Badge tone="danger">red flags</Badge> : null}
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="ghost" onClick={() => onMove(-1)} disabled={disabled || index === 0} aria-label={`Move step ${index + 1} up`}>
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" onClick={() => onMove(1)} disabled={disabled || index === count - 1} aria-label={`Move step ${index + 1} down`}>
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="text-danger" onClick={onRemove} disabled={disabled} aria-label={`Remove step ${index + 1}`}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {small(
          "Day",
          <Input type="number" min={0} max={400} value={days} onChange={(e) => set({ offsetHours: Math.max(0, Math.min(400, Math.floor(Number(e.target.value) || 0))) * 24 + hours })} disabled={disabled} />,
          errors.offsetHours,
        )}
        {small(
          "+ hours",
          <Input type="number" min={0} max={23} value={hours} onChange={(e) => set({ offsetHours: days * 24 + Math.max(0, Math.min(23, Math.floor(Number(e.target.value) || 0))) })} disabled={disabled} />,
        )}
        {small(
          "Kind",
          <Select value={step.kind} onChange={(e) => setKind(e.target.value as StepKind)} disabled={disabled}>
            {STEP_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_TEXT[k]}
              </option>
            ))}
          </Select>,
          errors.kind,
          "col-span-2 sm:col-span-1",
        )}
        {small("Title", <Input value={step.title} onChange={(e) => set({ title: e.target.value })} maxLength={120} disabled={disabled} />, errors.title, "col-span-2 sm:col-span-1")}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Goes out {days === 0 ? "on the procedure day" : `${days} day${days === 1 ? "" : "s"} after the procedure`}
        {hours ? `, ${hours} h after its time` : ", at the time of the procedure"}
        {step.kind === "INSTRUCTION" ? "" : " (never before 10:00 on the clinic clock)"}.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {small(
          "Message · Arabic",
          <Textarea dir="rtl" lang="ar" value={step.body.ar} onChange={(e) => set({ body: { ...step.body, ar: e.target.value } })} maxLength={2000} className="min-h-[5rem]" disabled={disabled} />,
          errors["body.ar"],
        )}
        {small(
          "Message · English",
          <Textarea value={step.body.en} onChange={(e) => set({ body: { ...step.body, en: e.target.value } })} maxLength={2000} className="min-h-[5rem]" disabled={disabled} />,
          errors["body.en"] ?? errors.body,
        )}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        <span className="font-mono">{"{{phone}}"}</span> becomes the clinic's number, <span className="font-mono">{"{{name}}"}</span> the patient's first name. Check-ins and photo requests get their link added.
      </p>

      {step.kind === "CHECK_IN" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="data-label">Questions</p>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={Boolean(step.satisfaction)} onChange={(e) => set({ satisfaction: e.target.checked || undefined })} disabled={disabled} />
              Ask satisfaction (1–5 stars)
            </label>
          </div>
          {errors.questions ? <p className="text-xs text-danger">{errors.questions}</p> : null}
          <ul className="space-y-3">
            {questions.map((q, i) => (
              <QuestionEditor
                key={`${id}-${i}`}
                q={q}
                errors={Object.fromEntries(
                  Object.entries(errors)
                    .filter(([k]) => k.startsWith(`questions.${i}.`) || k === `questions.${i}`)
                    .map(([k, v]) => [k.slice(`questions.${i}.`.length) || "key", v]),
                )}
                disabled={disabled}
                onChange={(next) => setQuestion(i, next)}
                onRemove={() => set({ questions: questions.filter((_, j) => j !== i) })}
              />
            ))}
          </ul>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={disabled || questions.length >= 20}
            onClick={() => set({ questions: [...questions, { key: `q${questions.length + 1}`, type: "yesno", label: { ar: "", en: "" }, expected: { value: false } }] })}
          >
            <Plus className="h-4 w-4" />
            Add question
          </Button>
        </div>
      ) : null}

      {step.kind === "PHOTO_REQUEST" ? <ViewsEditor views={step.photos ?? []} error={errors.photos} disabled={disabled} onChange={(photos) => set({ photos })} /> : null}
    </li>
  );
}

function QuestionEditor({
  q,
  errors,
  disabled,
  onChange,
  onRemove,
}: {
  q: ProtocolQuestion;
  errors: StepErrors;
  disabled: boolean;
  onChange: (q: ProtocolQuestion) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<ProtocolQuestion>) => onChange({ ...q, ...patch });
  const numeric = q.type === "scale" || q.type === "number";
  const setType = (type: QuestionType) => {
    const next: ProtocolQuestion = { key: q.key, label: q.label, type, ...(q.highRisk ? { highRisk: true } : {}) };
    if (type === "scale") Object.assign(next, { min: 0, max: 10, expected: { max: 4 } });
    if (type === "yesno") Object.assign(next, { expected: { value: false } });
    onChange(next);
  };
  const expectedValue = q.expected?.value === undefined ? "" : q.expected.value ? "yes" : "no";

  return (
    <li className="space-y-3 rounded-md border border-border p-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-[8rem_10rem_1fr_auto] sm:items-end">
        {small("Key", <Input className="font-mono" value={q.key} onChange={(e) => set({ key: e.target.value })} maxLength={40} disabled={disabled} />, errors.key)}
        {small(
          "Type",
          <Select value={q.type} onChange={(e) => setType(e.target.value as QuestionType)} disabled={disabled}>
            {QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_TEXT[t]}
              </option>
            ))}
          </Select>,
        )}
        <label className="col-span-2 flex items-center gap-2 text-sm sm:col-span-1 sm:pb-2.5">
          <Checkbox checked={Boolean(q.highRisk)} onChange={(e) => set({ highRisk: e.target.checked || undefined })} disabled={disabled || q.type === "text"} />
          <span>
            High risk when out of range <span className="text-xs text-muted-foreground">(15 / 30-min escalation)</span>
          </span>
        </label>
        <Button type="button" size="icon" variant="ghost" className="justify-self-end text-danger" onClick={onRemove} disabled={disabled} aria-label={`Remove question ${q.key}`}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {small("Question · Arabic", <Input dir="rtl" lang="ar" value={q.label.ar} onChange={(e) => set({ label: { ...q.label, ar: e.target.value } })} maxLength={200} disabled={disabled} />, errors["label.ar"])}
        {small("Question · English", <Input value={q.label.en} onChange={(e) => set({ label: { ...q.label, en: e.target.value } })} maxLength={200} disabled={disabled} />, errors["label.en"] ?? errors.label)}
      </div>
      {numeric ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {small("Answer from", <Input type="number" value={str(q.min)} onChange={(e) => set({ min: num(e.target.value) })} disabled={disabled} placeholder={q.type === "scale" ? "0" : ""} />)}
          {small("Answer to", <Input type="number" value={str(q.max)} onChange={(e) => set({ max: num(e.target.value) })} disabled={disabled} placeholder={q.type === "scale" ? "10" : ""} />, errors.max)}
          {small("Expected ≥", <Input type="number" value={str(q.expected?.min)} onChange={(e) => set({ expected: { ...q.expected, min: num(e.target.value) } })} disabled={disabled} />)}
          {small("Expected ≤", <Input type="number" value={str(q.expected?.max)} onChange={(e) => set({ expected: { ...q.expected, max: num(e.target.value) } })} disabled={disabled} />, errors.expected)}
          {small(
            "High risk at ≥",
            <Input
              type="number"
              value={str(q.danger?.min)}
              onChange={(e) => {
                const min = num(e.target.value);
                set({ danger: min === undefined && q.danger?.max === undefined ? undefined : { ...q.danger, min } });
              }}
              disabled={disabled}
            />,
            undefined,
            "col-span-2 sm:col-span-1",
          )}
        </div>
      ) : null}
      {q.type === "yesno" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {small(
            "Expected answer",
            <Select
              value={expectedValue}
              onChange={(e) => set({ expected: e.target.value === "" ? undefined : { value: e.target.value === "yes" } })}
              disabled={disabled}
            >
              <option value="">Either answer is fine</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </Select>,
          )}
        </div>
      ) : null}
      {q.type === "text" ? <p className="text-xs text-muted-foreground">Text answers are scanned for red-flag words (bleeding, fever, pus, cannot breathe…) in Arabic and English.</p> : null}
    </li>
  );
}

function ViewsEditor({ views, error, disabled, onChange }: { views: string[]; error?: string; disabled: boolean; onChange: (views: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const add = (v: string) => {
    const value = v.trim().toLowerCase().slice(0, 40);
    if (!value || views.includes(value) || views.length >= 6) return;
    onChange([...views, value]);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      <p className="data-label">Photo views requested (up to 4 are uploaded)</p>
      <ul className="flex flex-wrap gap-2">
        {views.map((v) => (
          <li key={v} className="inline-flex items-center gap-1 rounded-md bg-accent-muted px-2.5 py-1.5 text-sm text-accent">
            {viewLabel(v)}
            <button type="button" onClick={() => onChange(views.filter((x) => x !== v))} disabled={disabled} className="rounded-sm p-0.5 hover:bg-accent/20" aria-label={`Remove the ${v} view`}>
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Input
          className="h-9 w-40"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
          placeholder="Add a view"
          maxLength={40}
          disabled={disabled}
          aria-label="Add a photo view"
        />
        {VIEW_SUGGESTIONS.filter((v) => !views.includes(v))
          .slice(0, 4)
          .map((v) => (
            <Button key={v} type="button" size="sm" variant="ghost" onClick={() => add(v)} disabled={disabled}>
              <Plus className="h-3.5 w-3.5" />
              {viewLabel(v)}
            </Button>
          ))}
      </div>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

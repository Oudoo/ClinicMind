"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { DictationControl } from "@/components/clinicmind/dictation";
import { useToast } from "@/components/ui/toast";
import { apiFetch, fieldErrors } from "@/lib/http";
import { ChipInput } from "@/components/clinicmind/patient-chip-input";
import { apiErrorMessage, type HistoryFormValues } from "@/components/clinicmind/patient-shared";

const SECTIONS: { key: keyof HistoryFormValues; label: string; placeholder: string }[] = [
  { key: "chronicConditions", label: "Chronic conditions", placeholder: "e.g. Hypertension" },
  { key: "allergies", label: "Allergies", placeholder: "e.g. Penicillin" },
  { key: "diagnoses", label: "Diagnoses", placeholder: "e.g. Type 2 diabetes mellitus" },
  { key: "surgeries", label: "Surgeries", placeholder: "e.g. Appendectomy (2019)" },
];

/** "Edit history" button and the dialog editing all four medical history lists. */
export function MedicalHistoryEditor({ patientId, history }: { patientId: string; history: HistoryFormValues }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Pencil className="h-4 w-4" />
        Edit history
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          title="Edit medical history"
          description="Dictate the background or press Enter after each entry. Suggestions are only saved when you press Save history."
          className="max-h-[calc(100vh-2rem)] max-w-2xl overflow-y-auto"
        >
          {/* Mounted only while open, so every opening starts from the saved lists. */}
          <HistoryForm patientId={patientId} initial={history} onDone={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function HistoryForm({
  patientId,
  initial,
  onDone,
}: {
  patientId: string;
  initial: HistoryFormValues;
  onDone: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [values, setValues] = useState<HistoryFormValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [transcript, setTranscript] = useState<string | null>(null);

  /**
   * Dictated or pasted background -> suggested entries merged into the lists.
   * Nothing is saved until the clinician presses "Save history".
   */
  async function suggestFrom(text: string) {
    if (suggesting || text.trim().length < 10) return;
    setSuggesting(true);
    setSuggestNote(null);
    try {
      const res = await apiFetch<{ suggestions: HistoryFormValues; empty: boolean; provider: string }>(`/api/patients/${patientId}/history/extract`, {
        method: "POST",
        body: { text: text.trim() },
      });
      setTranscript(text.trim());
      if (res.empty) {
        setSuggestNote(
          res.provider === "echo"
            ? "No AI provider is configured for this clinic, so nothing could be suggested. Add the entries by hand."
            : "Nothing usable was recognised in the note. Add the entries by hand.",
        );
        return;
      }
      let added = 0;
      setValues((current) => {
        const next: HistoryFormValues = { ...current };
        for (const key of Object.keys(res.suggestions) as (keyof HistoryFormValues)[]) {
          const known = new Set(current[key].map((v) => v.toLowerCase()));
          const fresh = res.suggestions[key].filter((v) => !known.has(v.toLowerCase()));
          added += fresh.length;
          next[key] = [...current[key], ...fresh];
        }
        return next;
      });
      setSuggestNote(added ? `${added} suggested ${added === 1 ? "entry" : "entries"} added from the dictation. Review each one, then save.` : "Everything in the note was already on the record.");
    } catch (err) {
      setSuggestNote(apiErrorMessage(err));
    } finally {
      setSuggesting(false);
    }
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    try {
      await apiFetch(`/api/patients/${patientId}/history`, { method: "PATCH", body: values });
      toast({ title: "Medical history updated", tone: "success" });
      router.refresh();
      onDone();
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(fields);
      setFormError(Object.keys(fields).length ? "Please check the highlighted lists." : apiErrorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {formError ? <Alert>{formError}</Alert> : null}
      <div className="space-y-2 rounded-lg border border-border p-3">
        <p className="data-label">Dictate the history</p>
        <DictationControl patientId={patientId} disabled={pending || suggesting} onTranscript={(text) => void suggestFrom(text)} />
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Or paste a note</summary>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
            <Textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              rows={2}
              maxLength={20000}
              placeholder="e.g. Known hypertensive since 2019, allergic to penicillin, appendectomy in 2010"
              aria-label="Background note"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => void suggestFrom(noteText)} disabled={noteText.trim().length < 10 || suggesting}>
              {suggesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              Suggest
            </Button>
          </div>
        </details>
        {suggesting ? <p className="text-xs text-muted-foreground">Reading the note…</p> : null}
        {suggestNote ? <Alert tone="info">{suggestNote}</Alert> : null}
        {transcript ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Transcript</summary>
            <pre className="mt-1 whitespace-pre-wrap font-sans">{transcript}</pre>
          </details>
        ) : null}
      </div>
      {SECTIONS.map((section) => (
        <ChipInput
          key={section.key}
          id={`history-${section.key}`}
          label={section.label}
          values={values[section.key]}
          onChange={(list) => setValues((v) => ({ ...v, [section.key]: list }))}
          max={50}
          maxLength={120}
          placeholder={section.placeholder}
          error={errors[section.key]}
        />
      ))}
      <p className="text-xs text-muted-foreground">
        A diagnosis added here is also recorded on the patient's timeline.
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save history
        </Button>
      </DialogFooter>
    </form>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, Trash2, Type } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Alert, Field } from "@/components/ui/field";
import { Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/toast";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { useDictation, type DictationLanguage } from "@/components/clinicmind/use-dictation";
import { apiFetch, fieldErrors } from "@/lib/http";
import { formatDateTimeInTz } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { AppointmentDTO, AppointmentNoteDTO } from "@/modules/appointments/dto";
import { LANGUAGE_LABEL, MAX_NOTE_LENGTH, type AppointmentNoteKind } from "@/modules/appointments/transitions";
import { describeApiError } from "./appointment-shared";

export function formatSeconds(total: number): string {
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * The notes dropped onto one appointment: dictate (or type) a note, read the
 * transcript back and edit it before saving, see who left what and when, and
 * remove a note (its author, or a user manager). Everything goes through
 * `/api/appointments/[id]/notes`; the dialog keeps the list in sync.
 */
export function AppointmentNotesDialog({
  appointment,
  timezone,
  canWrite,
  canManage,
  userId,
  onOpenChange,
  onChanged,
}: {
  appointment: AppointmentDTO;
  timezone: string;
  canWrite: boolean;
  canManage: boolean;
  userId: string | null;
  onOpenChange: (open: boolean) => void;
  /** The number of live notes changed (badges on the calendar refresh). */
  onChanged?: (count: number) => void;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState<AppointmentNoteDTO[] | null>(appointment.dictatedNotes ?? null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ notes: AppointmentNoteDTO[] }>(`/api/appointments/${appointment.id}/notes`)
      .then((res) => {
        if (!cancelled) setNotes(res.notes);
      })
      .catch((err) => {
        if (!cancelled) setError(describeApiError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [appointment.id]);

  async function remove(note: AppointmentNoteDTO) {
    if (removing) return;
    setRemoving(note.id);
    try {
      await apiFetch(`/api/appointments/${appointment.id}/notes/${note.id}`, { method: "DELETE" });
      const next = (notes ?? []).filter((n) => n.id !== note.id);
      setNotes(next);
      onChanged?.(next.length);
      toast({ title: "Note removed", description: "The audit log keeps a record of it.", tone: "success" });
    } catch (err) {
      toast({ title: "Could not remove the note", description: describeApiError(err), tone: "danger" });
    } finally {
      setRemoving(null);
    }
  }

  const start = new Date(appointment.startsAt);
  const count = notes?.length ?? appointment.notesCount;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        title={`Notes · ${count}`}
        description={`${appointment.patient.fullName} · ${formatDateTimeInTz(start, timezone)}${appointment.doctor ? ` · ${appointment.doctor.fullName}` : ""}`}
        className="max-w-xl"
      >
        <div className="space-y-5">
          {error ? <Alert>{error}</Alert> : null}

          {canWrite ? (
            <NoteComposer
              appointment={appointment}
              onSaved={(note) => {
                const next = [...(notes ?? []), note];
                setNotes(next);
                onChanged?.(next.length);
              }}
            />
          ) : null}

          <section aria-label="Notes on this appointment" className="space-y-2">
            <p className="data-label">On this appointment</p>
            {notes === null ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : notes.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                No notes yet{canWrite ? " — dictate the first one above." : "."}
              </p>
            ) : (
              <ul className="space-y-2">
                {notes.map((note) => {
                  const mayRemove = canWrite && (canManage || (userId !== null && note.author?.id === userId));
                  return (
                    <li key={note.id} className="rounded-lg border border-border bg-card p-3">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <Badge tone={note.kind === "DICTATION" ? "accent" : "default"}>
                          {note.kind === "DICTATION" ? <Mic className="h-3 w-3" aria-hidden="true" /> : <Type className="h-3 w-3" aria-hidden="true" />}
                          {note.kind === "DICTATION" ? "Dictated" : "Typed"}
                        </Badge>
                        <span className="font-medium text-foreground">{note.author?.fullName ?? "Unknown"}</span>
                        <time dateTime={note.createdAt} className="font-mono tabular-nums">
                          {formatDateTimeInTz(new Date(note.createdAt), timezone)}
                        </time>
                        {note.language ? <span>{LANGUAGE_LABEL[note.language] ?? note.language}</span> : null}
                        {note.durationSeconds ? <span className="font-mono tabular-nums">{formatSeconds(note.durationSeconds)}</span> : null}
                        {mayRemove ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="ml-auto h-7 px-2 text-danger hover:bg-danger/10 hover:text-danger"
                            onClick={() => void remove(note)}
                            disabled={removing === note.id}
                            aria-label={`Remove this note by ${note.author?.fullName ?? "unknown"}`}
                          >
                            {removing === note.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                            Remove
                          </Button>
                        ) : null}
                      </div>
                      <p dir="auto" className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
                        {note.body}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dictate a note: pick the language, record, read the transcript back in an
 * editable preview and save. Typing in the preview without recording saves a
 * typed note; the microphone inside the field dictates at the caret.
 */
function NoteComposer({ appointment, onSaved }: { appointment: AppointmentDTO; onSaved: (note: AppointmentNoteDTO) => void }) {
  const { toast } = useToast();
  const [language, setLanguage] = useState<DictationLanguage>("auto");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<AppointmentNoteKind>("TEXT");
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<string | null>(null);
  const secondsRef = useRef(0);

  const d = useDictation({
    language,
    mode: "dictation",
    patientId: appointment.patientId,
    onTranscript: (transcript) => {
      setText((current) => (current.trim() ? `${current.trimEnd()}\n${transcript}` : transcript));
      setKind("DICTATION");
      setSeconds((s) => s + secondsRef.current);
    },
  });
  useEffect(() => {
    secondsRef.current = d.seconds;
  }, [d.seconds]);

  const recording = d.status === "recording";
  const uploading = d.status === "uploading";

  async function save() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setIssue(null);
    try {
      const res = await apiFetch<{ note: AppointmentNoteDTO }>(`/api/appointments/${appointment.id}/notes`, {
        method: "POST",
        body: {
          body,
          kind,
          language: language === "auto" ? undefined : language,
          durationSeconds: kind === "DICTATION" && seconds > 0 ? seconds : undefined,
        },
      });
      onSaved(res.note);
      setText("");
      setKind("TEXT");
      setSeconds(0);
      toast({ title: kind === "DICTATION" ? "Dictated note saved" : "Note saved", description: "It is kept with the appointment and shown in the consultation.", tone: "success" });
    } catch (err) {
      const fields = fieldErrors(err);
      setIssue(fields.body ?? describeApiError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Dictate a note" className="space-y-3 rounded-lg border border-accent/30 bg-accent-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Language"
          value={language}
          onChange={(e) => setLanguage(e.target.value as DictationLanguage)}
          disabled={busy || recording || uploading}
          className="h-9 w-auto"
        >
          <option value="auto">Auto (Arabic + English)</option>
          <option value="ar">Arabic</option>
          <option value="en">English</option>
        </Select>
        {d.unavailable ? null : recording ? (
          <Button type="button" variant="outline" onClick={d.stop} aria-label="Stop recording" className="border-danger/40 text-danger">
            <Square className="h-4 w-4 fill-current" />
            Stop · {formatSeconds(d.seconds)}
          </Button>
        ) : (
          <Button type="button" onClick={() => void d.start()} disabled={busy || uploading}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
            {uploading ? "Transcribing…" : "Dictate a note"}
          </Button>
        )}
        {recording ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-danger" /> recording
          </span>
        ) : null}
        <div role="group" aria-label="Note kind" className="ml-auto inline-flex h-8 items-center gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
          {(["DICTATION", "TEXT"] as const).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={cn(
                "inline-flex h-7 items-center gap-1 rounded-md px-2 font-medium transition-colors",
                kind === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {k === "DICTATION" ? <Mic className="h-3 w-3" aria-hidden="true" /> : <Type className="h-3 w-3" aria-hidden="true" />}
              {k === "DICTATION" ? "Dictated" : "Typed"}
            </button>
          ))}
        </div>
      </div>
      {d.unavailable ? <p className="text-xs text-muted-foreground">{d.unavailable}</p> : null}
      {d.error ? (
        <p role="alert" className="text-xs text-danger">
          {d.error}
        </p>
      ) : null}
      {d.note ? <p className="text-xs text-muted-foreground">{d.note}</p> : null}

      <Field
        label={kind === "DICTATION" ? "Transcript · read it before saving" : "Note"}
        htmlFor={`note-body-${appointment.id}`}
        hint={
          issue ? (
            <span className="text-danger">{issue}</span>
          ) : (
            <span className="flex justify-between gap-4">
              <span>{kind === "DICTATION" && seconds ? `${formatSeconds(seconds)} recorded · ` : ""}editable before it is saved</span>
              <span className="font-mono tabular-nums">
                {text.length.toLocaleString()} / {MAX_NOTE_LENGTH.toLocaleString()}
              </span>
            </span>
          )
        }
      >
        <DictationField
          language={language}
          patientId={appointment.patientId}
          disabled={busy}
          onDictated={(next) => {
            setText(next);
            setKind("DICTATION");
          }}
        >
          <Textarea
            id={`note-body-${appointment.id}`}
            dir="auto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_NOTE_LENGTH}
            rows={4}
            className="min-h-[5.5rem]"
            placeholder="The transcript appears here — or type a note for the doctor and the front desk."
            disabled={busy}
          />
        </DictationField>
      </Field>
      <div className="flex items-center justify-end gap-2">
        {text ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => { setText(""); setKind("TEXT"); setSeconds(0); }} disabled={busy}>
            Discard
          </Button>
        ) : null}
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy || !text.trim() || recording || uploading}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? "Saving…" : "Save note"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Notes are kept with the booking, written to the patient timeline and shown when the consultation starts.
      </p>
    </section>
  );
}

"use client";

import { useRef } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { insertAtCaret } from "@/lib/caret";
import { useDictation, type DictationLanguage } from "@/components/clinicmind/use-dictation";

export interface DictationFieldProps {
  /** Exactly one text input or textarea (a controlled field). */
  children: React.ReactNode;
  /** Receives the field's whole next value with the transcript inserted at the caret. */
  onDictated: (nextValue: string) => void;
  patientId?: string | null;
  language?: DictationLanguage;
  disabled?: boolean;
  /** Single-line inputs centre the button vertically; textareas keep it at the top. */
  multiline?: boolean;
  className?: string;
}

/**
 * A microphone inside a free-text field. One tap records, the next tap stops;
 * the transcript lands where the caret was (or at the end), with the field's
 * existing text kept. Egyptian Arabic and English mixes are left to the
 * model. Browsers that cannot record just show the plain field.
 */
export function DictationField({ children, onDictated, patientId, language = "auto", disabled = false, multiline = true, className }: DictationFieldProps) {
  const box = useRef<HTMLDivElement>(null);
  const d = useDictation({
    language,
    mode: "dictation",
    patientId,
    onTranscript: (text) => {
      const el = box.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>("textarea, input");
      if (!el) return;
      const next = insertAtCaret(el.value, el.selectionStart, el.selectionEnd, text);
      onDictated(next.value);
      // After React has written the new value, put the caret after the dictated text.
      window.requestAnimationFrame(() => {
        try {
          el.focus({ preventScroll: true });
          el.setSelectionRange(next.caret, next.caret);
        } catch {
          /* some input types have no selection */
        }
      });
    },
  });

  if (d.unavailable) return <>{children}</>;

  const recording = d.status === "recording";
  const busy = d.status === "uploading";
  const mm = String(Math.floor(d.seconds / 60)).padStart(2, "0");
  const ss = String(d.seconds % 60).padStart(2, "0");
  const label = recording ? `Stop dictating (${mm}:${ss})` : busy ? "Transcribing" : "Dictate into this field";

  return (
    <div ref={box} className={cn("relative", className)}>
      <div className="[&>input]:pr-10 [&>textarea]:pr-10">{children}</div>
      <button
        type="button"
        onClick={recording ? d.stop : () => void d.start()}
        disabled={disabled || busy}
        aria-label={label}
        title={label}
        aria-pressed={recording}
        className={cn(
          "absolute right-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          multiline ? "top-1.5" : "top-1/2 -translate-y-1/2",
          recording && "bg-danger/10 text-danger hover:bg-danger/15 hover:text-danger",
        )}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : recording ? <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" /> : <Mic className="h-4 w-4" aria-hidden="true" />}
        {recording ? (
          <span className="font-mono text-[11px] tabular-nums" aria-live="polite">
            {mm}:{ss}
          </span>
        ) : null}
      </button>
      {d.error ? (
        <p role="alert" className="mt-1 text-xs text-danger">
          {d.error}
        </p>
      ) : null}
    </div>
  );
}

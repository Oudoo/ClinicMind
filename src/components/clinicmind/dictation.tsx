"use client";

import { useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/input";
import { useDictation, type DictationLanguage, type DictationMode } from "@/components/clinicmind/use-dictation";

export type { DictationLanguage, DictationMode } from "@/components/clinicmind/use-dictation";

export interface DictationControlProps {
  /** Receives the transcript of one recording; the caller decides where it goes. */
  onTranscript: (text: string, meta: { provider: string; model: string; mode: DictationMode }) => void;
  patientId?: string | null;
  /** Offer the ambient (doctor + patient) mode with its consent confirmation. */
  allowAmbient?: boolean;
  disabled?: boolean;
}

/**
 * Microphone dictation for clinicians, with the language and mode choice:
 * dictation (doctor only) or ambient (doctor and patient, consent logged).
 * The recording pipeline is shared with the inline field microphones.
 */
export function DictationControl({ onTranscript, patientId, allowAmbient = false, disabled = false }: DictationControlProps) {
  const [mode, setMode] = useState<DictationMode>("dictation");
  const [language, setLanguage] = useState<DictationLanguage>("auto");
  const [consent, setConsent] = useState(false);
  const d = useDictation({ language, mode, patientId, consent, onTranscript: (text, meta) => onTranscript(text, meta) });

  if (d.unavailable) {
    return <p className="text-xs text-muted-foreground">{d.unavailable}</p>;
  }

  const recording = d.status === "recording";
  const idle = d.status === "idle";
  const mm = String(Math.floor(d.seconds / 60)).padStart(2, "0");
  const ss = String(d.seconds % 60).padStart(2, "0");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {allowAmbient ? (
          <Select
            aria-label="Recording mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as DictationMode)}
            disabled={disabled || !idle}
            className="h-9 w-auto"
          >
            <option value="dictation">Dictation (doctor only)</option>
            <option value="ambient">Ambient (doctor and patient)</option>
          </Select>
        ) : null}
        <Select
          aria-label="Language"
          value={language}
          onChange={(e) => setLanguage(e.target.value as DictationLanguage)}
          disabled={disabled || !idle}
          className="h-9 w-auto"
        >
          <option value="auto">Auto (Arabic + English)</option>
          <option value="ar">Arabic</option>
          <option value="en">English</option>
        </Select>
        {recording ? (
          <Button type="button" variant="outline" onClick={d.stop} aria-label="Stop recording" className="border-danger/40 text-danger">
            <Square className="h-4 w-4 fill-current" />
            Stop · {mm}:{ss}
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={() => void d.start()} disabled={disabled || d.status === "uploading"}>
            {d.status === "uploading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
            {d.status === "uploading" ? "Transcribing…" : mode === "ambient" ? "Record consultation" : "Dictate"}
          </Button>
        )}
        {recording ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-danger" /> recording
          </span>
        ) : null}
      </div>
      {allowAmbient && mode === "ambient" ? (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={disabled || !idle} className="mt-0.5" />
          The patient agreed to this consultation being recorded for documentation. The consent is logged with the encounter; the audio is deleted after transcription.
        </label>
      ) : null}
      {d.error ? (
        <p role="alert" className="text-xs text-danger">
          {d.error}
        </p>
      ) : null}
      {d.note ? <p className="text-xs text-muted-foreground">{d.note}</p> : null}
    </div>
  );
}

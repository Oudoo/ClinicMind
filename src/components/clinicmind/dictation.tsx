"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, Select } from "@/components/ui/input";
import type { TranscribeResponse } from "@/modules/consultations/types";

export type DictationMode = "dictation" | "ambient";
export type DictationLanguage = "auto" | "ar" | "en";

export interface DictationControlProps {
  /** Receives the transcript of one recording; the caller decides where it goes. */
  onTranscript: (text: string, meta: { provider: string; model: string; mode: DictationMode }) => void;
  patientId?: string | null;
  /** Offer the ambient (doctor + patient) mode with its consent confirmation. */
  allowAmbient?: boolean;
  disabled?: boolean;
}

/** Recordings stop themselves after 15 minutes; the upload limit is 15 MB. */
const MAX_SECONDS = 15 * 60;
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/**
 * Why dictation is unavailable, or "" when it works. Read on the client; the
 * server render assumes support so the markup matches. Browsers expose the
 * microphone only on https (and localhost), so a plain-http deployment is the
 * usual cause rather than the browser itself.
 */
function detectSupport(): string {
  if (typeof window !== "undefined" && window.isSecureContext === false) return "Dictation needs a secure (https) connection; this page was opened over plain http.";
  if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia || pickMimeType() === "")
    return "Dictation needs a browser that can record audio (current Chrome, Edge, Firefox or Safari). Type or paste the transcript instead.";
  return "";
}
const subscribeNoop = () => () => {};

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0] ?? "";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  return "webm";
}

/**
 * Microphone dictation for clinicians. Records in the browser (MediaRecorder),
 * sends the audio to the clinic's speech-to-text provider and hands back the
 * transcript. Nothing is written anywhere by this control; the audio is not
 * stored. Egyptian Arabic and English mixes are left to the model: "Auto" is
 * the right choice unless the speech is clearly one language.
 */
export function DictationControl({ onTranscript, patientId, allowAmbient = false, disabled = false }: DictationControlProps) {
  const unavailable = useSyncExternalStore(subscribeNoop, detectSupport, () => "");
  const [mode, setMode] = useState<DictationMode>("dictation");
  const [language, setLanguage] = useState<DictationLanguage>("auto");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<"idle" | "recording" | "uploading">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);

  // Release the microphone and the timer if the dialog or page closes mid-recording.
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    setError(null);
    setNote(null);
    if (mode === "ambient" && !consent) {
      setError("Confirm the patient's consent before recording the consultation.");
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      setError("Microphone access was refused. Allow the microphone for this site and try again.");
      return;
    }
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(media, { mimeType });
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.current.push(e.data);
    };
    rec.onstop = () => {
      media.getTracks().forEach((t) => t.stop());
      stream.current = null;
      if (timer.current) window.clearInterval(timer.current);
      timer.current = null;
      void upload(new Blob(chunks.current, { type: mimeType }));
    };
    recorder.current = rec;
    stream.current = media;
    rec.start(1000);
    setSeconds(0);
    setStatus("recording");
    timer.current = window.setInterval(() => {
      setSeconds((s) => {
        if (s + 1 >= MAX_SECONDS) stop();
        return s + 1;
      });
    }, 1000);
  }

  function stop() {
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorder.current = null;
  }

  async function upload(blob: Blob) {
    if (!blob.size) {
      setStatus("idle");
      setError("Nothing was recorded.");
      return;
    }
    setStatus("uploading");
    const form = new FormData();
    form.append("audio", blob, `dictation.${extensionFor(blob.type)}`);
    form.append("language", language);
    form.append("mode", mode);
    if (mode === "ambient") form.append("consent", "true");
    if (patientId) form.append("patientId", patientId);
    try {
      const res = await fetch("/api/consultations/transcribe", { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json().catch(() => null)) as (Partial<TranscribeResponse> & { error?: string; message?: string }) | null;
      if (!res.ok) {
        setError(body?.message ?? messageFor(res.status));
        return;
      }
      if (!body?.transcript) {
        setNote("No speech was recognised. Speak closer to the microphone and try again.");
        return;
      }
      setNote(`Transcribed by ${body.provider ?? "the clinic's provider"} in ${Math.round((body.latencyMs ?? 0) / 100) / 10} s. Read it before you extract: it is a draft, not the record.`);
      onTranscript(body.transcript, { provider: body.provider ?? "", model: body.model ?? "", mode });
    } catch {
      setError("The recording could not be sent. Check the connection and try again.");
    } finally {
      setStatus("idle");
    }
  }

  if (unavailable) {
    return <p className="text-xs text-muted-foreground">{unavailable}</p>;
  }

  const recording = status === "recording";
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {allowAmbient ? (
          <Select
            aria-label="Recording mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as DictationMode)}
            disabled={disabled || status !== "idle"}
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
          disabled={disabled || status !== "idle"}
          className="h-9 w-auto"
        >
          <option value="auto">Auto (Arabic + English)</option>
          <option value="ar">Arabic</option>
          <option value="en">English</option>
        </Select>
        {recording ? (
          <Button type="button" variant="outline" onClick={stop} aria-label="Stop recording" className="border-danger/40 text-danger">
            <Square className="h-4 w-4 fill-current" />
            Stop · {mm}:{ss}
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={start} disabled={disabled || status === "uploading"}>
            {status === "uploading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
            {status === "uploading" ? "Transcribing…" : mode === "ambient" ? "Record consultation" : "Dictate"}
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
          <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={disabled || status !== "idle"} className="mt-0.5" />
          The patient agreed to this consultation being recorded for documentation. The consent is logged with the encounter; the audio is deleted after transcription.
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function messageFor(status: number): string {
  switch (status) {
    case 503:
      return "No speech-to-text provider is configured for this clinic. Type or paste the transcript instead.";
    case 413:
      return "The recording is too long for one upload. Stop and transcribe in shorter parts.";
    case 415:
      return "This browser's audio format is not accepted. Try Chrome or Edge.";
    case 429:
      return "Too many requests. Wait a moment and try again.";
    case 401:
      return "Your session has expired. Sign in again.";
    default:
      return "Transcription failed. Try again.";
  }
}

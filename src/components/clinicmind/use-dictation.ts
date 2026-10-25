"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TranscribeResponse } from "@/modules/consultations/types";

export type DictationMode = "dictation" | "ambient";
export type DictationLanguage = "auto" | "ar" | "en";
export type DictationStatus = "idle" | "recording" | "uploading";
export interface DictationMeta {
  provider: string;
  model: string;
  mode: DictationMode;
  latencyMs: number;
}

/** Recordings stop themselves after 15 minutes; the upload limit is 15 MB. */
export const MAX_SECONDS = 15 * 60;
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

/** "" when the browser can record; otherwise the reason, for the user. */
export function useDictationSupport(): string {
  return useSyncExternalStore(subscribeNoop, detectSupport, () => "");
}

function extensionFor(mimeType: string): string {
  const base = mimeType.split(";")[0] ?? "";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/ogg") return "ogg";
  return "webm";
}

export function messageFor(status: number): string {
  switch (status) {
    case 503:
      return "No speech-to-text provider is configured for this clinic. Type or paste the text instead.";
    case 413:
      return "The recording is too long for one upload. Stop and dictate in shorter parts.";
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

export interface UseDictationOptions {
  language: DictationLanguage;
  mode: DictationMode;
  patientId?: string | null;
  /** Required for the ambient mode; the recording is refused without it. */
  consent?: boolean;
  /** Receives the transcript of one recording; the caller decides where it goes. */
  onTranscript: (text: string, meta: DictationMeta) => void;
}

/**
 * The one recording pipeline behind every microphone in the product: records
 * in the browser (MediaRecorder), sends the audio to the clinic's
 * speech-to-text provider and hands back the transcript. Nothing is written
 * anywhere by the hook; the audio is not stored.
 */
export function useDictation(options: UseDictationOptions) {
  const unavailable = useDictationSupport();
  const [status, setStatus] = useState<DictationStatus>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  // The latest options, read when a recording ends (not when it started).
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // Release the microphone and the timer if the dialog or page closes mid-recording.
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  function stop() {
    const rec = recorder.current;
    if (rec && rec.state !== "inactive") rec.stop();
    recorder.current = null;
  }

  async function start() {
    setError(null);
    setNote(null);
    const { mode, consent } = latest.current;
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

  async function upload(blob: Blob) {
    if (!blob.size) {
      setStatus("idle");
      setError("Nothing was recorded.");
      return;
    }
    setStatus("uploading");
    const { language, mode, patientId, onTranscript } = latest.current;
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
      const latencyMs = body.latencyMs ?? 0;
      setNote(`Transcribed by ${body.provider ?? "the clinic's provider"} in ${Math.round(latencyMs / 100) / 10} s. Read it before you rely on it: it is a draft, not the record.`);
      onTranscript(body.transcript, { provider: body.provider ?? "", model: body.model ?? "", mode, latencyMs });
    } catch {
      setError("The recording could not be sent. Check the connection and try again.");
    } finally {
      setStatus("idle");
    }
  }

  return { unavailable, status, seconds, error, note, start, stop };
}

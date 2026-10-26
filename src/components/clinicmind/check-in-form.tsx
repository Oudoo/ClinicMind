"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Camera, CheckCircle2, ClipboardCheck, Clock, ImageIcon, Loader2, Phone, RefreshCw, Send, Star, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CHECK_IN_COPY, type CheckInCopy } from "@/modules/concierge/check-in-copy";
import type { PublicCheckInDTO, PublicCheckInResult } from "@/modules/concierge/dto";
import { viewLabel } from "@/modules/concierge/labels";
import { SATISFACTION_QUESTION, type Language, type ProtocolQuestion } from "@/modules/concierge/protocols";

/**
 * The patient's check-in page behind the WhatsApp link: one step of the
 * protocol in Arabic (right to left) or English, big touch targets, 0–10
 * sliders, yes/no buttons, number and text answers, satisfaction stars,
 * photos taken with the rear camera and shrunk on the phone to at most
 * 1600 px (JPEG) before upload, then a thank-you, or the clinic's number and
 * the call-back promise when the answers are high risk.
 */
type AnswerValue = number | boolean | string;

interface Photo {
  view: string;
  name: string;
  type: string;
  /** Base64 without the data-URL prefix. */
  data: string;
  previewUrl: string | null;
  bytes: number;
}

type ResultState = { kind: "done"; result: PublicCheckInResult } | { kind: "expired" } | null;

const EXTRA = "__extra";

/** Decode, orient and shrink a photo to `maxSide` px as JPEG; null when this browser cannot decode it (e.g. HEIC on Chrome). */
async function downscale(file: File, maxSide: number): Promise<Blob | null> {
  let width = 0;
  let height = 0;
  let source: CanvasImageSource | null = null;
  let cleanup = () => {};
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
      cleanup = () => bitmap.close();
    } else {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("decode"));
        img.src = url;
      });
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
      cleanup = () => URL.revokeObjectURL(url);
    }
    if (!width || !height) return null;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.85));
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("read"));
    reader.readAsDataURL(blob);
  });
}

export function CheckInForm({ token, data, productName }: { token: string; data: PublicCheckInDTO; productName: string }) {
  const id = useId();
  const [lang, setLang] = useState<Language>(data.language);
  const copy = CHECK_IN_COPY[lang];
  const step = data.step;
  const [answers, setAnswers] = useState<Record<string, AnswerValue | undefined>>({});
  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const [freeText, setFreeText] = useState("");
  const [photos, setPhotos] = useState<Record<string, Photo>>({});
  const [preparing, setPreparing] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<ResultState>(null);
  const urls = useRef<string[]>([]);

  // Free the photo previews when the page goes away.
  useEffect(() => {
    const held = urls.current;
    return () => held.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const slots = step.kind === "PHOTO_REQUEST" ? step.photos.slice(0, data.limits.maxPhotos) : step.kind === "CHECK_IN" ? [EXTRA] : [];

  const setAnswer = (key: string, value: AnswerValue | undefined) => {
    setAnswers((a) => ({ ...a, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: "" }));
  };

  async function addPhoto(slot: string, file: File | undefined) {
    if (!file) return;
    setPreparing(slot);
    setErrors((e) => ({ ...e, photos: "", [`photo:${slot}`]: "" }));
    try {
      const shrunk = file.type.startsWith("image/") || !file.type ? await downscale(file, data.limits.maxPhotoSide) : null;
      let blob: Blob;
      let type: string;
      if (shrunk) {
        blob = shrunk;
        type = "image/jpeg";
      } else if (file.size <= data.limits.maxPhotoBytes && /^image\/(jpeg|png|webp|heic|heif|gif)$/.test(file.type || "image/heic")) {
        // This browser cannot draw it (HEIC on most Android browsers): send it as it is.
        blob = file;
        type = file.type || "image/heic";
      } else {
        setErrors((e) => ({ ...e, [`photo:${slot}`]: shrunk === null && file.size > data.limits.maxPhotoBytes ? copy.errors.photoTooLarge : copy.errors.photoRead }));
        return;
      }
      if (blob.size > data.limits.maxPhotoBytes) {
        setErrors((e) => ({ ...e, [`photo:${slot}`]: copy.errors.photoTooLarge }));
        return;
      }
      const base64 = await toBase64(blob);
      const previewUrl = type === "image/jpeg" || type === "image/png" || type === "image/webp" || type === "image/gif" ? URL.createObjectURL(blob) : null;
      if (previewUrl) urls.current.push(previewUrl);
      setPhotos((p) => {
        const old = p[slot]?.previewUrl;
        if (old) URL.revokeObjectURL(old);
        return { ...p, [slot]: { view: slot === EXTRA ? "photo" : slot, name: file.name.slice(0, 100), type, data: base64, previewUrl, bytes: blob.size } };
      });
    } catch {
      setErrors((e) => ({ ...e, [`photo:${slot}`]: copy.errors.photoRead }));
    } finally {
      setPreparing(null);
    }
  }

  function removePhoto(slot: string) {
    setPhotos((p) => {
      const next = { ...p };
      const old = next[slot]?.previewUrl;
      if (old) URL.revokeObjectURL(old);
      delete next[slot];
      return next;
    });
  }

  function validate(): Record<string, string> {
    const next: Record<string, string> = {};
    if (step.kind === "CHECK_IN") {
      for (const q of step.questions) {
        if (q.type === "text") continue;
        const v = answers[q.key];
        if (v === undefined || v === "") next[q.key] = copy.errors.required;
      }
      if (step.satisfaction && !satisfaction) next.satisfaction = copy.errors.satisfaction;
    }
    if (step.kind === "PHOTO_REQUEST" && !Object.keys(photos).length) next.photos = copy.errors.photos;
    return next;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || preparing) return;
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) {
      setFormError(copy.errors.fix);
      document.getElementById(`${id}-q-${Object.keys(found)[0]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const list = Object.values(photos);
    const payload = {
      answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== undefined && v !== "")),
      satisfaction,
      freeText: freeText.trim() || undefined,
      photos: list.map((p) => ({ view: p.view, name: p.name, type: p.type, data: p.data })),
    };
    const body = JSON.stringify(payload);
    if (body.length > data.limits.maxBodyBytes) {
      setFormError(copy.errors.tooLarge);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/public/check-in/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (res.ok && json) {
        setState({ kind: "done", result: json as unknown as PublicCheckInResult });
        window.scrollTo({ top: 0 });
        return;
      }
      if (res.status === 404) {
        setState({ kind: "expired" });
        return;
      }
      if (res.status === 422) {
        const fields = ((json?.issues as { fieldErrors?: Record<string, string[]> } | undefined)?.fieldErrors ?? {}) as Record<string, string[]>;
        const mapped: Record<string, string> = {};
        for (const key of Object.keys(fields)) mapped[key] = key === "photos" ? copy.errors.photos : key === "satisfaction" ? copy.errors.satisfaction : copy.errors.required;
        setErrors(mapped);
        const code = json?.error;
        setFormError(code === "photo_type" ? copy.errors.photoRead : code === "photo_too_large" ? copy.errors.photoTooLarge : code === "too_many_photos" ? copy.errors.tooLarge : copy.errors.fix);
        return;
      }
      setFormError(res.status === 413 ? copy.errors.tooLarge : res.status === 429 ? copy.errors.tooMany : copy.errors.generic);
    } catch {
      setFormError(copy.errors.offline);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div dir={copy.dir} lang={lang} className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate font-display text-base font-semibold tracking-tight">{data.clinicName}</p>
            <p className="truncate text-xs text-muted-foreground">{copy.title}</p>
          </div>
          <button
            type="button"
            onClick={() => setLang(lang === "ar" ? "en" : "ar")}
            className="h-11 shrink-0 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
            lang={lang === "ar" ? "en" : "ar"}
          >
            {copy.switchTo}
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-xl px-4 py-5">
        {state?.kind === "done" ? (
          <Done result={state.result} copy={copy} />
        ) : state?.kind === "expired" ? (
          <Expired copy={copy} />
        ) : (
          <form onSubmit={submit} noValidate className="space-y-4">
            <div>
              <p className="data-label">{step.dayLabel[lang]}</p>
              <h1 className="mt-0.5 font-display text-2xl font-semibold tracking-tight">{step.heading[lang]}</h1>
              <p className="mt-2 text-base">{copy.greeting(data.patientFirstName)}</p>
              {step.body[lang] || step.body[lang === "ar" ? "en" : "ar"] ? (
                <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{step.body[lang] || step.body[lang === "ar" ? "en" : "ar"]}</p>
              ) : null}
              {data.late ? (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-warning">
                  <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {copy.late}
                </p>
              ) : null}
            </div>

            {formError ? <Alert>{formError}</Alert> : null}

            {step.questions.map((q, i) => (
              <QuestionCard
                key={q.key}
                id={`${id}-q-${q.key}`}
                index={i + 1}
                q={q}
                lang={lang}
                copy={copy}
                value={answers[q.key]}
                error={errors[q.key]}
                onChange={(v) => setAnswer(q.key, v)}
              />
            ))}

            {step.satisfaction ? (
              <fieldset id={`${id}-q-satisfaction`} className={cn("bento space-y-3 p-4 sm:p-5", errors.satisfaction && "border-danger")}>
                <legend className="sr-only">{copy.satisfaction}</legend>
                <p className="text-base font-medium" aria-hidden="true">
                  {lang === "ar" ? SATISFACTION_QUESTION.ar : SATISFACTION_QUESTION.en}
                </p>
                <div className="flex justify-between gap-1" role="radiogroup" aria-label={copy.satisfaction}>
                  {[1, 2, 3, 4, 5].map((n) => {
                    const on = satisfaction !== null && n <= satisfaction;
                    return (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={satisfaction === n}
                        aria-label={copy.stars(n)}
                        onClick={() => {
                          setSatisfaction(n);
                          if (errors.satisfaction) setErrors((e) => ({ ...e, satisfaction: "" }));
                        }}
                        className="flex h-14 flex-1 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Star className={cn("h-9 w-9 transition-colors", on ? "fill-current text-warning" : "text-muted-foreground/40")} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                {errors.satisfaction ? (
                  <p role="alert" className="text-sm text-danger">
                    {errors.satisfaction}
                  </p>
                ) : null}
              </fieldset>
            ) : null}

            {slots.length ? (
              <section id={`${id}-q-photos`} className={cn("bento space-y-3 p-4 sm:p-5", errors.photos && "border-danger")} aria-labelledby={`${id}-photos-title`}>
                <div>
                  <h2 id={`${id}-photos-title`} className="text-base font-medium">
                    {step.kind === "PHOTO_REQUEST" ? copy.photosTitle : copy.extraPhoto}
                    {step.kind === "PHOTO_REQUEST" ? null : <span className="ms-1 text-xs font-normal text-muted-foreground">({copy.optional})</span>}
                  </h2>
                  <p className="text-xs text-muted-foreground">{copy.photosHint}</p>
                </div>
                <div className={cn("grid gap-3", slots.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
                  {slots.map((slot) => (
                    <PhotoSlot
                      key={slot}
                      id={`${id}-photo-${slot}`}
                      label={slot === EXTRA ? copy.takePhoto : viewLabel(slot, lang)}
                      photo={photos[slot] ?? null}
                      preparing={preparing === slot}
                      error={errors[`photo:${slot}`]}
                      copy={copy}
                      wide={slots.length === 1}
                      onFile={(f) => void addPhoto(slot, f)}
                      onRemove={() => removePhoto(slot)}
                    />
                  ))}
                </div>
                {errors.photos ? (
                  <p role="alert" className="text-sm text-danger">
                    {errors.photos}
                  </p>
                ) : null}
              </section>
            ) : null}

            <div className="bento space-y-2 p-4 sm:p-5">
              <label htmlFor={`${id}-free`} className="block text-base font-medium">
                {copy.freeText} <span className="text-xs font-normal text-muted-foreground">({copy.optional})</span>
              </label>
              <Textarea id={`${id}-free`} value={freeText} onChange={(e) => setFreeText(e.target.value)} maxLength={2000} rows={3} className="min-h-[5.5rem] text-base" placeholder={copy.freeTextHint} />
            </div>

            <button
              type="submit"
              disabled={busy || Boolean(preparing)}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-accent text-base font-semibold text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Send className="h-5 w-5 rtl:-scale-x-100" aria-hidden="true" />}
              {busy ? copy.sending : copy.submit}
            </button>
            <p className="text-center text-xs text-muted-foreground">{copy.privacy}</p>
          </form>
        )}

        <p className="mt-8 text-center text-xs text-muted-foreground">
          {copy.poweredBy} {productName}
        </p>
      </main>
    </div>
  );
}

function QuestionCard({
  id,
  index,
  q,
  lang,
  copy,
  value,
  error,
  onChange,
}: {
  id: string;
  index: number;
  q: ProtocolQuestion;
  lang: Language;
  copy: CheckInCopy;
  value: AnswerValue | undefined;
  error?: string;
  onChange: (value: AnswerValue | undefined) => void;
}) {
  const label = (lang === "ar" ? q.label.ar : q.label.en) || q.label.en || q.label.ar;
  const labelId = `${id}-label`;
  return (
    <fieldset id={id} className={cn("bento space-y-3 p-4 sm:p-5", error && "border-danger")} aria-labelledby={labelId}>
      <p id={labelId} className="text-base font-medium">
        <span className="me-1.5 font-mono text-sm text-muted-foreground">{index}.</span>
        {label}
      </p>
      {q.type === "scale" ? <ScaleInput id={id} q={q} copy={copy} value={typeof value === "number" ? value : undefined} onChange={onChange} labelId={labelId} /> : null}
      {q.type === "yesno" ? (
        <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-labelledby={labelId}>
          {[
            [true, copy.yes],
            [false, copy.no],
          ].map(([v, text]) => (
            <button
              key={String(v)}
              type="button"
              role="radio"
              aria-checked={value === v}
              onClick={() => onChange(v as boolean)}
              className={cn(
                "h-14 rounded-lg border-2 text-lg font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                value === v ? "border-accent bg-accent-muted text-accent" : "border-border hover:bg-muted",
              )}
            >
              {text as string}
            </button>
          ))}
        </div>
      ) : null}
      {q.type === "number" ? (
        <input
          type="number"
          inputMode="decimal"
          dir="ltr"
          aria-labelledby={labelId}
          value={value === undefined ? "" : String(value)}
          min={q.min}
          max={q.max}
          step="any"
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          placeholder={copy.numberPlaceholder}
          className="h-14 w-full rounded-lg border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring"
        />
      ) : null}
      {q.type === "text" ? (
        <Textarea aria-labelledby={labelId} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} maxLength={500} rows={3} className="min-h-[5.5rem] text-base" />
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** A 0–10 slider that stays "not answered" until the patient touches it (a default would read as an answer). */
function ScaleInput({
  id,
  q,
  copy,
  value,
  onChange,
  labelId,
}: {
  id: string;
  q: ProtocolQuestion;
  copy: CheckInCopy;
  value: number | undefined;
  onChange: (value: number) => void;
  labelId: string;
}) {
  const min = q.min ?? 0;
  const max = q.max ?? 10;
  const mid = Math.round((min + max) / 2);
  const answered = value !== undefined;
  const pick = (target: HTMLInputElement) => onChange(Number(target.value));
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className={cn("font-display text-4xl font-semibold tabular-nums", answered ? "text-foreground" : "text-muted-foreground/40")} aria-hidden="true">
          {answered ? value : "–"}
          <span className="text-base font-normal text-muted-foreground"> / {max}</span>
        </span>
        <span className="text-xs text-muted-foreground">{answered ? copy.scaleHint : copy.scaleNotAnswered}</span>
      </div>
      <input
        id={`${id}-range`}
        type="range"
        min={min}
        max={max}
        step={1}
        value={answered ? value : mid}
        aria-labelledby={labelId}
        aria-valuetext={answered ? `${value} / ${max}` : copy.scaleNotAnswered}
        onChange={(e) => pick(e.currentTarget)}
        onPointerUp={(e) => pick(e.currentTarget)}
        onKeyUp={(e) => pick(e.currentTarget)}
        className={cn(
          "h-12 w-full cursor-pointer appearance-none bg-transparent touch-pan-y",
          "[&::-webkit-slider-runnable-track]:h-3 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-muted",
          "[&::-webkit-slider-thumb]:-mt-2.5 [&::-webkit-slider-thumb]:box-border [&::-webkit-slider-thumb]:h-8 [&::-webkit-slider-thumb]:w-8 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-4 [&::-webkit-slider-thumb]:border-card [&::-webkit-slider-thumb]:shadow",
          "[&::-moz-range-track]:h-3 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted",
          "[&::-moz-range-thumb]:box-border [&::-moz-range-thumb]:h-8 [&::-moz-range-thumb]:w-8 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-4 [&::-moz-range-thumb]:border-card",
          answered
            ? "[&::-moz-range-thumb]:bg-accent [&::-webkit-slider-thumb]:bg-accent"
            : "[&::-moz-range-thumb]:bg-muted-foreground/40 [&::-webkit-slider-thumb]:bg-muted-foreground/40",
        )}
      />
      <div className="flex justify-between font-mono text-xs text-muted-foreground" aria-hidden="true">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <button key={n} type="button" tabIndex={-1} onClick={() => onChange(n)} className={cn("w-6 rounded py-1 text-center", value === n && "bg-accent-muted font-semibold text-accent")}>
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function PhotoSlot({
  id,
  label,
  photo,
  preparing,
  error,
  copy,
  wide,
  onFile,
  onRemove,
}: {
  id: string;
  label: string;
  photo: Photo | null;
  preparing: boolean;
  error?: string;
  copy: CheckInCopy;
  wide: boolean;
  onFile: (file: File | undefined) => void;
  onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="min-w-0 space-y-1.5">
      <input
        ref={input}
        id={id}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(e) => {
          onFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      <label
        htmlFor={id}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border-2 border-dashed text-center text-sm font-medium transition-colors hover:bg-muted",
          wide ? "h-40" : "aspect-square",
          photo ? "border-success p-0" : "border-border p-3",
          error && "border-danger",
        )}
      >
        {preparing ? (
          <>
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" aria-hidden="true" />
            <span className="text-xs text-muted-foreground">{copy.preparing}</span>
          </>
        ) : photo ? (
          photo.previewUrl ? (
            <img src={photo.previewUrl} alt={label} className="h-full w-full object-cover" />
          ) : (
            <>
              <ImageIcon className="h-7 w-7 text-success" aria-hidden="true" />
              <span className="max-w-full truncate px-2 text-xs text-muted-foreground">{photo.name}</span>
            </>
          )
        ) : (
          <>
            <Camera className="h-8 w-8 text-accent" aria-hidden="true" />
            <span>{label}</span>
            {!wide ? <span className="text-xs font-normal text-muted-foreground">{copy.takePhoto}</span> : null}
          </>
        )}
      </label>
      {photo ? (
        <div className="flex items-center justify-between gap-1">
          <span className="truncate text-xs font-medium">{label}</span>
          <span className="flex shrink-0 gap-1">
            <button type="button" onClick={() => input.current?.click()} className="flex h-10 w-10 items-center justify-center rounded-md border border-border hover:bg-muted" aria-label={`${copy.retake}: ${label}`}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={onRemove} className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-danger hover:bg-danger/10" aria-label={`${copy.remove}: ${label}`}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </button>
          </span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Done({ result, copy }: { result: PublicCheckInResult; copy: CheckInCopy }) {
  if (result.triage === "HIGH_RISK") {
    const minutes = result.callbackMinutes ?? (result.outOfHours ? 30 : 15);
    return (
      <div className="space-y-4" role="status">
        <div className="bento space-y-3 border-danger/50 bg-danger/5 text-center">
          <AlertTriangle className="mx-auto h-12 w-12 text-danger" aria-hidden="true" />
          <h1 className="font-display text-2xl font-semibold tracking-tight">{copy.done.urgentTitle}</h1>
          <p className="text-lg font-medium">{copy.done.urgent(minutes)}</p>
        </div>
        <div className="bento space-y-3 text-center">
          {result.clinicPhone ? (
            <>
              <p className="text-sm text-muted-foreground">{copy.done.callNow}</p>
              <a
                href={`tel:${result.clinicPhone.replace(/[^\d+]/g, "")}`}
                dir="ltr"
                className="flex h-14 w-full items-center justify-center gap-2 rounded-lg bg-danger text-lg font-semibold text-white hover:bg-danger/90"
              >
                <Phone className="h-5 w-5" aria-hidden="true" />
                {result.clinicPhone}
              </a>
            </>
          ) : (
            <p className="text-sm">{copy.done.noPhone}</p>
          )}
          <p className="text-xs text-muted-foreground">{copy.done.emergency}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="bento flex flex-col items-center gap-3 text-center" role="status">
      {result.triage === "WATCH" ? <ClipboardCheck className="h-12 w-12 text-warning" aria-hidden="true" /> : <CheckCircle2 className="h-12 w-12 text-success" aria-hidden="true" />}
      <h1 className="font-display text-2xl font-semibold tracking-tight">{copy.done.title}</h1>
      <p className="text-base">{result.triage === "WATCH" ? copy.done.watch : copy.done.ok}</p>
      {result.triage === "WATCH" && result.clinicPhone ? (
        <p className="text-sm text-muted-foreground">
          {copy.done.callNow}{" "}
          <a href={`tel:${result.clinicPhone.replace(/[^\d+]/g, "")}`} dir="ltr" className="font-medium text-accent underline">
            {result.clinicPhone}
          </a>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{copy.done.close}</p>
    </div>
  );
}

function Expired({ copy }: { copy: CheckInCopy }) {
  return (
    <div className="bento flex flex-col items-center gap-3 text-center" role="status">
      <Clock className="h-10 w-10 text-warning" aria-hidden="true" />
      <h1 className="font-display text-xl font-semibold tracking-tight">{copy.expired.title}</h1>
      <p className="text-sm text-muted-foreground">{copy.expired.body}</p>
    </div>
  );
}

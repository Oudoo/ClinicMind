"use client";

import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { BookOpenCheck, ExternalLink, Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/primitives";
import { AnswerRating } from "@/components/clinicmind/answer-rating";
import { deidentify } from "@/lib/ai/deidentify";
import { apiFetch, ApiError, fieldErrors } from "@/lib/http";
import type { EvidenceAnswerDTO, EvidenceCitationDTO } from "@/modules/evidence/dto";

const QUESTION_MAX = 1_000;
const ARABIC = /[؀-ۿ]/;
const OPENEVIDENCE = "https://www.openevidence.com/";

/**
 * The evidence panel beside the consultation review: the doctor asks in
 * Arabic or English, the patient's facts go with the question without their
 * name, phone, ID or date of birth (listed here before asking), and the
 * answer comes only from the clinic's approved library, each statement
 * marked with the passage it comes from. "No good source" is said plainly.
 * "Ask OpenEvidence" opens OpenEvidence in a new tab with the question
 * copied, the patient's name and numbers taken out.
 */
export function EvidencePanel({ patientId, patientName = null }: { patientId: string | null; patientName?: string | null }) {
  const id = useId();
  const [context, setContext] = useState<string[] | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ asked: string; result: EvidenceAnswerDTO } | null>(null);
  const [external, setExternal] = useState<{ text: string; copied: boolean | null } | null>(null);

  useEffect(() => {
    if (!patientId) return;
    let cancelled = false;
    apiFetch<{ context: string[] }>(`/api/evidence/context?patientId=${encodeURIComponent(patientId)}`)
      .then((data) => {
        if (!cancelled) setContext(data.context);
      })
      .catch((err: unknown) => {
        if (!cancelled) setContextError(err instanceof Error ? err.message : "The patient's facts could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const trimmed = question.trim();
  const canAsk = trimmed.length >= 3 && !busy;

  async function ask(e?: FormEvent) {
    e?.preventDefault();
    if (!canAsk) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetch<EvidenceAnswerDTO>("/api/evidence/ask", { method: "POST", body: { question: trimmed, ...(patientId ? { patientId } : {}) } });
      setAnswer({ asked: trimmed, result });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setError(fieldErrors(err).question ?? err.message);
      else if (err instanceof ApiError && err.status === 403) setError("Only clinicians ask the library: a doctor, or the owner with the clinician mark.");
      else setError(err instanceof Error ? err.message : "The question could not be asked. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** OpenEvidence is outside the clinic: the question goes without the patient's name or numbers, and the copy is logged. */
  function askOpenEvidence() {
    if (trimmed.length < 3) return;
    const text = deidentify(trimmed, patientName ? { fullName: patientName } : null);
    // Opened inside the click, so no pop-up blocker stops it.
    window.open(OPENEVIDENCE, "_blank", "noopener,noreferrer");
    setExternal({ text, copied: null });
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => setExternal({ text, copied: true }),
        () => setExternal({ text, copied: false }),
      );
    } else {
      setExternal({ text, copied: false });
    }
    void apiFetch("/api/evidence/external", { method: "POST", body: { question: trimmed, ...(patientId ? { patientId } : {}) } }).catch(() => undefined);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void ask();
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 rounded-lg border border-border p-3 sm:p-4" data-testid="evidence-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${id}-title`} className="flex items-center gap-2 text-sm font-semibold">
          <BookOpenCheck className="h-4 w-4 text-accent" aria-hidden="true" />
          Evidence
        </h3>
        <Link href="/dashboard/evidence" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          The clinic&apos;s library
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Answers come only from the guidelines, drug information and protocols the clinic approved, each statement marked with its source.
      </p>

      {patientId ? (
        <div className="rounded-md bg-muted/50 px-3 py-2 text-xs" data-testid="evidence-context">
          <p className="font-medium text-foreground">Sent with your question</p>
          {context ? (
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {context.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : contextError ? (
            <p className="mt-1 text-muted-foreground">{contextError}</p>
          ) : (
            <p className="mt-1 inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Loading…
            </p>
          )}
          <p className="mt-1 text-muted-foreground">Never the name, phone, ID or date of birth; a name or number typed in the question is taken out.</p>
        </div>
      ) : null}

      <form onSubmit={(e) => void ask(e)} className="space-y-2">
        <label htmlFor={`${id}-question`} className="data-label block">
          Question
        </label>
        <Textarea
          id={`${id}-question`}
          rows={2}
          dir="auto"
          maxLength={QUESTION_MAX}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Can doxycycline be given with isotretinoin? · ينفع دوكسيسيكلين مع روكيتان؟"
          disabled={busy}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Arabic or English.</span>
          <span className="flex flex-wrap justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={askOpenEvidence} disabled={trimmed.length < 3}>
              <ExternalLink />
              Ask OpenEvidence
            </Button>
            <Button type="submit" size="sm" disabled={!canAsk}>
              {busy ? <Loader2 className="animate-spin" /> : <Search />}
              Ask the library
            </Button>
          </span>
        </div>
      </form>

      {external ? (
        <div role="status" className="space-y-1 rounded-md border border-border px-3 py-2 text-xs" data-testid="openevidence-notice">
          <p className="font-medium text-foreground">
            {external.copied === false
              ? "OpenEvidence opened in a new tab. Copy the question from here, without the patient's name:"
              : "OpenEvidence opened in a new tab; the question is copied without the patient's name. Paste it there:"}
          </p>
          <p dir="auto" className="select-all rounded bg-muted/60 px-2 py-1 font-mono text-[11px] text-foreground">
            {external.text}
          </p>
          <p className="text-muted-foreground">OpenEvidence is outside the clinic: never paste a name, phone number or ID into it.</p>
        </div>
      ) : null}

      {error ? <Alert>{error}</Alert> : null}
      {answer ? <EvidenceAnswer key={answer.result.runId ?? answer.asked} asked={answer.asked} result={answer.result} /> : null}
    </section>
  );
}

function EvidenceAnswer({ asked, result }: { asked: string; result: EvidenceAnswerDTO }) {
  const id = useId();
  const rtl = ARABIC.test(asked);
  const anchor = (n: number) => `${id}-source-${n}`;
  return (
    <div className="space-y-3 border-t border-border pt-3" data-testid="evidence-answer" aria-live="polite">
      {result.sentQuestion !== asked ? (
        <p className="text-xs text-muted-foreground" dir="auto">
          Asked as: “{result.sentQuestion}” (the patient&apos;s name and numbers taken out).
        </p>
      ) : null}
      {result.grounded ? (
        <>
          <div className="space-y-1.5 text-sm" dir={rtl ? "rtl" : "ltr"}>
            {result.statements.map((s, i) => (
              <p key={i} dir="auto">
                {s.text}{" "}
                {s.cites.map((n) => (
                  <a key={n} href={`#${anchor(n)}`} className="align-super font-mono text-[10px] text-accent no-underline hover:underline" aria-label={`Source ${n}`}>
                    [{n}]
                  </a>
                ))}
              </p>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {result.mode === "library"
              ? "Quoted from the sources below, in their own words."
              : `Written by the clinic's AI model (${result.model}) from the passages below only. Check each statement against its source.`}
          </p>
          <ol className="space-y-2" aria-label="Sources">
            {result.citations.map((c) => (
              <Citation key={c.n} c={c} id={anchor(c.n)} />
            ))}
          </ol>
        </>
      ) : (
        <Alert tone="info" data-testid="evidence-no-source">
          <span dir="auto">{result.noGoodSource}</span>
          <span className="mt-1 block text-xs">
            If the clinic should have one, add it to the library; the owner approves it before the panel quotes it.
          </span>
        </Alert>
      )}
      <AnswerRating runId={result.runId} />
    </div>
  );
}

function Citation({ c, id }: { c: EvidenceCitationDTO; id: string }) {
  const by = [c.publisher, c.year].filter(Boolean).join(", ");
  return (
    <li id={id} className="scroll-mt-4 rounded-md border border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 font-medium text-foreground">
          <span className="font-mono text-accent">[{c.n}]</span> {c.title}
          {by ? <span className="font-normal text-muted-foreground"> · {by}</span> : null}
        </p>
        <Badge>{c.kindLabel}</Badge>
      </div>
      {c.heading ? <p className="mt-0.5 text-muted-foreground">{c.heading}</p> : null}
      <details className="mt-1">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">The passage</summary>
        <blockquote dir="auto" className="mt-1 whitespace-pre-line border-l-2 border-accent/40 pl-2 text-foreground">
          {c.passage}
        </blockquote>
      </details>
      <p className="mt-1 flex flex-wrap gap-3">
        <Link href={`/dashboard/evidence?source=${c.sourceId}`} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Open in the library
        </Link>
        {c.url ? (
          <a href={c.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Original
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        ) : null}
      </p>
    </li>
  );
}

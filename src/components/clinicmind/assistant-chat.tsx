"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Database,
  HelpCircle,
  Info,
  Loader2,
  Quote,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DictationField } from "@/components/clinicmind/dictate-field";
import { Badge } from "@/components/ui/primitives";
import { apiFetch, ApiError } from "@/lib/http";

interface Citation {
  index: number;
  source: string;
  refId: string;
  patientId: string | null;
  patientName: string | null;
  title: string;
  snippet: string;
  href: string | null;
}

interface CohortFact {
  label: string;
  value: string;
  where: string;
  note?: string | null;
  unmet?: boolean;
}

interface CohortRow {
  index: number;
  patientId: string;
  name: string;
  age: number | null;
  sex: "MALE" | "FEMALE" | "OTHER" | "UNDISCLOSED";
  facts: CohortFact[];
  href: string;
}

interface CohortPayload {
  banner: string;
  headline: string;
  lines: string[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  complete: boolean;
  rows: CohortRow[];
  criteria: string[];
}

interface ClarifyOption {
  label: string;
  query?: string;
  patientId?: string;
  patientName?: string;
}

interface ClarifyPayload {
  reason: "not_understood" | "ambiguous_patient" | "patient_not_found" | "context_mismatch";
  ignored: string[];
  understood: string[];
  options: ClarifyOption[];
}

type Mode = "cohort" | "patient" | "rag" | "clarify";

interface AssistantResponse {
  answer: string;
  citations: Citation[];
  confidence: number;
  grounded: boolean;
  provider: string;
  model: string;
  latencyMs: number;
  mode?: Mode;
  criteria?: string[];
  cohort?: CohortPayload;
  clarify?: ClarifyPayload;
  scope?: { label: string; patients: number | null } | null;
  notices?: string[];
}

export interface PatientOption {
  id: string;
  fullName: string;
}

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  confidence?: number;
  grounded?: boolean;
  provider?: string;
  model?: string;
  /** Patient context the question was asked in. */
  patient?: PatientOption | null;
  error?: boolean;
  mode?: Mode;
  criteria?: string[];
  cohort?: CohortPayload;
  clarify?: ClarifyPayload;
  scope?: { label: string; patients: number | null } | null;
  notices?: string[];
  /** The question this answers (for "show more" and clarification choices). */
  question?: string;
  loadingMore?: boolean;
  /** Loading the next page failed (shown inline: the chat also runs in the embed, without toasts). */
  moreError?: string | null;
}

/**
 * Suggestions for a dermatology & hair-transplant clinic. Every one is a
 * structured question answered from the full record (the first lists every
 * patient with either allergy; the audit's test case).
 */
const CLINIC_SUGGESTIONS = [
  "Which patients have a documented allergy to lidocaine or penicillin?",
  "Who is currently on finasteride, and at what dose?",
  "Which patients had an FUE hair transplant, and how many grafts?",
  "Who was treated for acne vulgaris and what was prescribed?",
  "Which patients over 40 have melasma?",
  "مين عنده حساسية من البنسلين؟",
];

const PATIENT_SUGGESTIONS = [
  "Summarise this patient's history and active medications",
  "Any allergies or contraindications to check before a procedure?",
  "What was decided at the last visit, and what follow-up is due?",
  "Which treatments has this patient had for hair loss so far?",
];

const DISCLAIMER = "Decision support from this clinic's records; verify before acting.";

export function AssistantChat({ initialPatient = null }: { initialPatient?: PatientOption | null }) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [patient, setPatient] = useState<PatientOption | null>(initialPatient);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const last = turns[turns.length - 1];
    // A new answer opens at its top (banner, count and headline in view);
    // a new question and the "searching" indicator scroll to the bottom.
    if (last?.role === "assistant" && !loading) {
      const el = box.querySelector<HTMLElement>(`[data-turn="${turns.length - 1}"]`);
      if (el) {
        const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
        box.scrollTo({ top, behavior: "smooth" });
        return;
      }
    }
    box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a turn is added or loading flips
  }, [turns.length, loading]);

  async function send(message: string, contextOverride?: PatientOption | null) {
    const text = message.trim();
    if (!text || loading) return;
    const context = contextOverride === undefined ? patient : contextOverride;
    setTurns((t) => [...t, { role: "user", content: text, patient: context }]);
    setInput("");
    setLoading(true);
    try {
      const data = await apiFetch<AssistantResponse>("/api/assistant", {
        method: "POST",
        body: { query: text, ...(context ? { patientId: context.id } : {}) },
      });
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          content: data.answer || "No answer was produced.",
          citations: data.citations ?? [],
          confidence: data.confidence,
          grounded: data.grounded,
          provider: data.provider,
          model: data.model,
          mode: data.mode ?? "rag",
          criteria: data.criteria ?? [],
          cohort: data.cohort,
          clarify: data.clarify,
          scope: data.scope ?? null,
          notices: data.notices ?? [],
          question: text,
          patient: context,
        },
      ]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", content: describeError(err), error: true }]);
    } finally {
      setLoading(false);
    }
  }

  /** Load the next page of a cohort answer and append its patients to the same turn. */
  async function loadMore(turnIndex: number) {
    const turn = turns[turnIndex];
    if (!turn?.cohort || !turn.question || turn.loadingMore) return;
    const nextPage = turn.cohort.page + 1;
    setTurns((t) => t.map((x, i) => (i === turnIndex ? { ...x, loadingMore: true, moreError: null } : x)));
    try {
      const data = await apiFetch<AssistantResponse>("/api/assistant", {
        method: "POST",
        body: { query: turn.question, page: nextPage, ...(turn.patient ? { patientId: turn.patient.id } : {}) },
      });
      setTurns((t) =>
        t.map((x, i) => {
          if (i !== turnIndex || !x.cohort) return x;
          const more = data.cohort?.rows ?? [];
          return {
            ...x,
            loadingMore: false,
            cohort: { ...x.cohort, page: data.cohort?.page ?? nextPage, rows: [...x.cohort.rows, ...more] },
            citations: [...(x.citations ?? []), ...(data.citations ?? [])],
          };
        }),
      );
    } catch (err) {
      setTurns((t) => t.map((x, i) => (i === turnIndex ? { ...x, loadingMore: false, moreError: describeError(err) } : x)));
    }
  }

  function choose(option: ClarifyOption, turn: ChatTurn) {
    if (option.patientId && option.patientName) {
      const next = { id: option.patientId, fullName: option.patientName };
      setPatient(next);
      void send(turn.question ?? "", next);
    } else if (option.query) {
      void send(option.query);
    }
  }

  const suggestions = patient ? PATIENT_SUGGESTIONS : CLINIC_SUGGESTIONS;

  return (
    <div className="bento flex h-[calc(100vh-7.5rem)] min-w-0 flex-col p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="data-label">Patient context</span>
        {patient ? (
          <span className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs text-accent">
            <UserRound className="h-3 w-3 shrink-0" />
            <span className="truncate">{patient.fullName}</span>
            <button
              type="button"
              onClick={() => setPatient(null)}
              aria-label="Clear patient context"
              className="ml-1 rounded hover:bg-accent/20"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ) : (
          <PatientPicker onSelect={setPatient} />
        )}
        <span className="text-[11px] text-muted-foreground sm:ml-auto">
          {patient ? "Answers are limited to this patient's records." : "All of this clinic's records."}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-3 sm:p-6">
        {turns.length === 0 ? (
          <div className="flex min-h-full flex-col items-center justify-center gap-5 py-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-flow text-white">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold">Doctor AI Assistant</h3>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                List questions (allergies, conditions, medications, sex, age, tags, doctors, appointments, last visit) are answered
                from every patient record, with the full count. Other questions are answered from the most relevant records, with
                citations — and when nothing matches, it says so.
              </p>
            </div>
            <div className="grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  dir="auto"
                  onClick={() => send(s)}
                  className="rounded-md border border-border bg-card px-3 py-2 text-start text-sm hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div key={i} data-turn={i} className={`flex min-w-0 ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`min-w-0 rounded-lg px-3 py-3 text-sm sm:px-4 ${
                  turn.role === "user"
                    ? "max-w-[85%] bg-accent text-accent-foreground sm:max-w-[80%]"
                    : turn.error
                      ? "max-w-[92%] border border-danger/30 bg-danger/5 sm:max-w-[85%]"
                      : "w-full max-w-[96%] border border-border bg-card sm:max-w-[85%]"
                }`}
              >
                {turn.role === "user" ? (
                  <>
                    {turn.patient ? (
                      <p className="mb-1 text-[11px] opacity-80">
                        <UserRound className="mr-1 inline h-3 w-3" />
                        {turn.patient.fullName}
                      </p>
                    ) : null}
                    <p dir="auto" className="whitespace-pre-wrap break-words">
                      {turn.content}
                    </p>
                  </>
                ) : turn.error ? (
                  <p className="whitespace-pre-wrap break-words">{turn.content}</p>
                ) : turn.mode === "cohort" || turn.mode === "patient" ? (
                  <CohortAnswer turn={turn} onMore={() => loadMore(i)} />
                ) : turn.mode === "clarify" ? (
                  <ClarifyAnswer turn={turn} disabled={loading} onChoose={(o) => choose(o, turn)} />
                ) : (
                  <RagAnswer turn={turn} />
                )}
              </div>
            </div>
          ))
        )}
        {loading ? (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <span className="data-label animate-pulse-spike">searching the records…</span>
            </div>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-border p-3 sm:p-4"
      >
        <div className="flex items-center gap-2">
          <DictationField multiline={false} onDictated={setInput} disabled={loading} patientId={patient?.id ?? null} className="min-w-0 flex-1">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={2000}
              dir="auto"
              placeholder={patient ? `Ask about ${patient.fullName}…` : "Ask about patients, treatments, allergies, follow-ups…"}
              aria-label="Question"
              className="h-10 w-full rounded-lg border border-input bg-background px-4 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </DictationField>
          <Button type="submit" size="icon" disabled={loading || !input.trim()} aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {turns.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {suggestions.slice(0, 2).map((s) => (
              <button
                key={s}
                type="button"
                dir="auto"
                onClick={() => send(s)}
                disabled={loading}
                className="max-w-full truncate rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
        <p className="mt-2 text-[11px] text-muted-foreground">{DISCLAIMER}</p>
      </form>
    </div>
  );
}

// ── Cohort and single-patient answers ────────────────────────────────────────

function CohortAnswer({ turn, onMore }: { turn: ChatTurn; onMore: () => void }) {
  const cohort = turn.cohort!;
  const shown = cohort.rows.length;
  const arabic = /[؀-ۿ]/.test(cohort.banner);
  const banner =
    turn.mode === "cohort" && shown > cohort.pageSize
      ? arabic
        ? `الإجابة من السجلات: عدد المرضى المطابقين ${cohort.total} (${shown >= cohort.total ? "معروضين كلهم" : `معروض ${shown}`})`
        : `Answered from the record: ${cohort.total} patient${cohort.total === 1 ? "" : "s"} matched (${shown >= cohort.total ? "all shown" : `showing ${shown} of ${cohort.total}`})`
      : cohort.banner;
  const more = turn.mode === "cohort" && shown < cohort.total;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="success" title="Searched every patient record of this clinic, not a sample">
          <Database className="h-3 w-3" /> from the record
        </Badge>
        <span dir="auto" className="text-xs font-medium text-foreground" data-testid="cohort-banner">
          {banner}
        </span>
      </div>
      {cohort.criteria.length ? (
        <div className="flex flex-wrap gap-1.5" aria-label="Understood as">
          {cohort.criteria.map((c) => (
            <span key={c} className="max-w-full break-words rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
              {c}
            </span>
          ))}
        </div>
      ) : null}
      <p dir="auto" className="break-words font-medium">
        {cohort.headline}
      </p>
      {cohort.lines.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {cohort.lines.map((l) => (
            <li key={l} dir="auto" className="break-words">
              {l}
            </li>
          ))}
        </ul>
      ) : null}
      {cohort.rows.length ? (
        <ol className="divide-y divide-border/60 rounded-md border border-border/60" aria-label="Matching patients">
          {cohort.rows.map((row) => (
            <PatientRowItem key={`${row.index}-${row.patientId}`} row={row} />
          ))}
        </ol>
      ) : null}
      {more ? (
        <Button type="button" variant="outline" size="sm" onClick={onMore} disabled={turn.loadingMore}>
          {turn.loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Show the next {Math.min(cohort.pageSize, cohort.total - shown)} patients
        </Button>
      ) : null}
      {turn.moreError ? (
        <p role="alert" className="text-xs text-danger">
          Could not load more patients: {turn.moreError}
        </p>
      ) : null}
      <AnswerFooter turn={turn} />
    </div>
  );
}

function PatientRowItem({ row }: { row: CohortRow }) {
  const who = [row.age !== null ? `${row.age}` : null, sexLabel(row.sex)].filter(Boolean).join(" · ");
  return (
    <li className="flex gap-2 px-3 py-2">
      <span className="mt-0.5 shrink-0 font-mono text-[11px] text-accent">[{row.index}]</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <PatientLink href={row.href} label={row.name} />
          {who ? <span className="text-[11px] text-muted-foreground">{who}</span> : null}
        </div>
        {row.facts.length ? (
          <ul className="mt-1 space-y-0.5">
            {row.facts.map((f, k) => (
              <li key={k} className={`flex gap-1.5 text-xs ${f.unmet ? "text-muted-foreground" : ""}`}>
                {f.unmet ? (
                  <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-label="on record" />
                ) : (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" aria-label="matched" />
                )}
                <span className="min-w-0 break-words">
                  <span className="font-medium">{f.label}:</span> {f.value}
                  {f.note ? <span className="text-muted-foreground"> ({f.note})</span> : null}
                  <span className="text-muted-foreground"> — {f.where}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function PatientLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="break-words font-medium text-foreground underline-offset-2 hover:text-accent hover:underline"
      onClick={(e) => {
        // Inside the embed iframe, open the dashboard in a new tab rather than
        // navigating the host's frame away from the chat.
        if (window.self !== window.top) {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      }}
    >
      {label}
    </Link>
  );
}

// ── Clarifications ───────────────────────────────────────────────────────────

function ClarifyAnswer({ turn, disabled, onChoose }: { turn: ChatTurn; disabled: boolean; onChoose: (o: ClarifyOption) => void }) {
  const clarify = turn.clarify;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="warning">
          <HelpCircle className="h-3 w-3" /> {clarify?.reason === "ambiguous_patient" ? "which patient?" : clarify?.reason === "context_mismatch" ? "different patient" : "not answered"}
        </Badge>
      </div>
      <p dir="auto" className="whitespace-pre-wrap break-words">
        {turn.content}
      </p>
      {clarify?.ignored.length ? (
        <p className="text-xs text-muted-foreground">
          Not used: {clarify.ignored.map((x) => `“${x}”`).join(", ")}
        </p>
      ) : null}
      {clarify?.options.length ? (
        <div className="flex flex-wrap gap-1.5">
          {clarify.options.map((o) => (
            <button
              key={`${o.label}-${o.patientId ?? ""}`}
              type="button"
              dir="auto"
              disabled={disabled}
              onClick={() => onChoose(o)}
              className="max-w-full break-words rounded-md border border-border px-2 py-1 text-start text-xs hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {o.patientId ? <UserRound className="mr-1 inline h-3 w-3" /> : null}
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Retrieval answers ────────────────────────────────────────────────────────

function RagAnswer({ turn }: { turn: ChatTurn }) {
  return (
    <div className="space-y-3">
      {turn.scope?.label ? (
        <p className="text-[11px] text-muted-foreground">
          Limited to: <span className="font-medium text-foreground">{turn.scope.label}</span>
          {turn.scope.patients !== null && turn.scope.patients !== 1 ? ` (${turn.scope.patients} patients)` : null}
        </p>
      ) : null}
      <p dir="auto" className="whitespace-pre-wrap break-words">
        {turn.content}
      </p>
      {turn.notices?.length ? (
        <ul className="space-y-1">
          {turn.notices.map((n) => (
            <li key={n} className="flex gap-1.5 rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
              <span className="min-w-0 break-words">{n}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {turn.citations && turn.citations.length > 0 ? (
        <div className="space-y-1.5 border-t border-border/60 pt-3">
          {turn.citations.map((c) => (
            <CitationRow key={`${c.index}-${c.refId}`} citation={c} />
          ))}
        </div>
      ) : null}
      <AnswerFooter turn={turn} />
    </div>
  );
}

function AnswerFooter({ turn }: { turn: ChatTurn }) {
  const structured = turn.mode === "cohort" || turn.mode === "patient";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {structured ? (
        <Badge tone="success" title="A database query over every record; no AI generation">
          <ShieldCheck className="h-3 w-3" /> complete search
        </Badge>
      ) : turn.grounded ? (
        <Badge tone="success" title={confidenceTooltip(turn.confidence)}>
          <ShieldCheck className="h-3 w-3" /> grounded
        </Badge>
      ) : (
        <Badge tone="warning" title={confidenceTooltip(turn.confidence)}>
          <AlertTriangle className="h-3 w-3" /> no matching records
        </Badge>
      )}
      {turn.provider ? <Badge title={turn.model}>{turn.provider}</Badge> : null}
    </div>
  );
}

function CitationRow({ citation }: { citation: Citation }) {
  const label = [citation.patientName, citation.title].filter(Boolean).join(" · ");
  return (
    <div className="flex gap-2 text-xs text-muted-foreground">
      <Quote className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
      <span className="min-w-0 break-words">
        <span className="font-mono text-accent">[{citation.index}]</span>{" "}
        <span className="font-mono uppercase">{citation.source.replace(/_/g, " ")}</span>
        {label ? (
          <>
            {" · "}
            {citation.href ? <PatientLink href={citation.href} label={label} /> : <span className="font-medium text-foreground">{label}</span>}
          </>
        ) : null}
        {" — "}
        {citation.snippet}
      </span>
    </div>
  );
}

/** Search-as-you-type picker over GET /api/patients?q= (returns `{ patients }`). */
function PatientPicker({ onSelect }: { onSelect: (patient: PatientOption) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientOption[]>([]);
  const [open, setOpen] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const requestId = useRef(0);

  const search = useCallback(async (q: string) => {
    const id = ++requestId.current;
    try {
      const data = await apiFetch<{ patients: PatientOption[] }>(`/api/patients?q=${encodeURIComponent(q)}`);
      if (id !== requestId.current) return;
      setResults((data.patients ?? []).slice(0, 8).map((p) => ({ id: p.id, fullName: p.fullName })));
      setOpen(true);
    } catch (err) {
      if (id !== requestId.current) return;
      if (err instanceof ApiError && err.status === 403) setUnavailable(true);
      setResults([]);
    }
  }, []);

  function onQueryChange(value: string) {
    setQuery(value);
    if (value.trim().length < 2) {
      requestId.current += 1; // drop any in-flight result
      setResults([]);
      setOpen(false);
    }
  }

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const handle = setTimeout(() => void search(q), 250);
    return () => clearTimeout(handle);
  }, [query, search]);

  if (unavailable) return null;

  return (
    <div className="relative min-w-0">
      <div className="flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2">
        <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search a patient to focus on…"
          aria-label="Search patients"
          className="w-40 min-w-0 bg-transparent text-xs focus:outline-none sm:w-48"
        />
      </div>
      {open && results.length ? (
        <ul className="absolute left-0 top-8 z-10 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-card shadow-lg">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(p);
                  setQuery("");
                  setResults([]);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted"
              >
                <UserRound className="h-3 w-3 text-muted-foreground" />
                {p.fullName}
              </button>
            </li>
          ))}
        </ul>
      ) : open && query.trim().length >= 2 ? (
        <div className="absolute left-0 top-8 z-10 w-64 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg">
          No patients match.
        </div>
      ) : null}
    </div>
  );
}

function sexLabel(sex: CohortRow["sex"]): string | null {
  switch (sex) {
    case "MALE":
      return "male";
    case "FEMALE":
      return "female";
    case "OTHER":
      return "other";
    default:
      return null;
  }
}

function confidenceTooltip(confidence?: number): string {
  return typeof confidence === "number" ? `Confidence ${Math.round(confidence * 100)}%` : "Confidence unavailable";
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) return "The AI provider did not answer. Please try again in a moment.";
    if (err.status === 404) return "That patient could not be found in this clinic.";
    if (err.status === 403) return "Your role does not include the AI assistant.";
    if (err.status === 429) return "Too many questions in a short time. Wait a moment and try again.";
    return err.message;
  }
  return "Request failed. Try again.";
}

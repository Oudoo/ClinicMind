"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Quote, Search, Send, ShieldCheck, Sparkles, UserRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
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

interface AssistantResponse {
  answer: string;
  citations: Citation[];
  confidence: number;
  grounded: boolean;
  provider: string;
  model: string;
  latencyMs: number;
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
}

/** Suggestions for a dermatology & hair-transplant clinic. */
const CLINIC_SUGGESTIONS = [
  "Which patients have a documented allergy to lidocaine or penicillin?",
  "Who is currently on isotretinoin, and at what dose?",
  "Which patients had an FUE hair transplant, and how many grafts?",
  "Who was treated for acne vulgaris and what was prescribed?",
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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, loading]);

  async function send(message: string) {
    const text = message.trim();
    if (!text || loading) return;
    const context = patient;
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
        },
      ]);
    } catch (err) {
      setTurns((t) => [...t, { role: "assistant", content: describeError(err), error: true }]);
    } finally {
      setLoading(false);
    }
  }

  const suggestions = patient ? PATIENT_SUGGESTIONS : CLINIC_SUGGESTIONS;

  return (
    <div className="bento flex h-[calc(100vh-7.5rem)] flex-col p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="data-label">Patient context</span>
        {patient ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-accent-muted px-2 py-1 text-xs text-accent">
            <UserRound className="h-3 w-3" />
            {patient.fullName}
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
        <span className="ml-auto text-[11px] text-muted-foreground">
          {patient ? "Answers are limited to this patient's records." : "All of this clinic's records."}
        </span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-6">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-5 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-indigo-flow text-white">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <h3 className="font-display text-lg font-semibold">Doctor AI Assistant</h3>
              <p className="mt-1 max-w-md text-sm text-muted-foreground">
                Ask in natural language. Every answer is retrieved from this clinic's own records and cites
                the record it came from — when nothing matches, it says so.
              </p>
            </div>
            <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
              {suggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-md border border-border bg-card px-3 py-2 text-left text-sm hover:border-accent hover:text-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div key={i} className={`flex ${turn.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
                  turn.role === "user"
                    ? "bg-accent text-accent-foreground"
                    : turn.error
                      ? "border border-danger/30 bg-danger/5"
                      : "border border-border bg-card"
                }`}
              >
                {turn.role === "user" && turn.patient ? (
                  <p className="mb-1 text-[11px] opacity-80">
                    <UserRound className="mr-1 inline h-3 w-3" />
                    {turn.patient.fullName}
                  </p>
                ) : null}
                <p className="whitespace-pre-wrap">{turn.content}</p>

                {turn.citations && turn.citations.length > 0 ? (
                  <div className="mt-3 space-y-1.5 border-t border-border/60 pt-3">
                    {turn.citations.map((c) => (
                      <CitationRow key={`${c.index}-${c.refId}`} citation={c} />
                    ))}
                  </div>
                ) : null}

                {turn.role === "assistant" && !turn.error ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {turn.grounded ? (
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
                ) : null}
              </div>
            </div>
          ))
        )}
        {loading ? (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <span className="data-label animate-pulse-spike">retrieving + reasoning…</span>
            </div>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-border p-4"
      >
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={2000}
            placeholder={patient ? `Ask about ${patient.fullName}…` : "Ask about patients, treatments, allergies, follow-ups…"}
            className="h-10 flex-1 rounded-lg border border-input bg-background px-4 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
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
                onClick={() => send(s)}
                disabled={loading}
                className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50"
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

function CitationRow({ citation }: { citation: Citation }) {
  const label = [citation.patientName, citation.title].filter(Boolean).join(" · ");
  return (
    <div className="flex gap-2 text-xs text-muted-foreground">
      <Quote className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
      <span>
        <span className="font-mono text-accent">[{citation.index}]</span>{" "}
        <span className="font-mono uppercase">{citation.source.replace(/_/g, " ")}</span>
        {label ? (
          <>
            {" · "}
            {citation.href ? (
              <Link
                href={citation.href}
                className="font-medium text-foreground underline-offset-2 hover:text-accent hover:underline"
                onClick={(e) => {
                  // Inside the embed iframe, open the dashboard in a new tab
                  // rather than navigating the host's frame away from the chat.
                  if (window.self !== window.top) {
                    e.preventDefault();
                    window.open(citation.href ?? "", "_blank", "noopener,noreferrer");
                  }
                }}
              >
                {label}
              </Link>
            ) : (
              <span className="font-medium text-foreground">{label}</span>
            )}
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
    <div className="relative">
      <div className="flex h-7 items-center gap-1 rounded-md border border-input bg-background px-2">
        <Search className="h-3 w-3 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search a patient to focus on…"
          aria-label="Search patients"
          className="w-48 bg-transparent text-xs focus:outline-none"
        />
      </div>
      {open && results.length ? (
        <ul className="absolute left-0 top-8 z-10 w-64 overflow-hidden rounded-md border border-border bg-card shadow-lg">
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
        <div className="absolute left-0 top-8 z-10 w-64 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg">
          No patients match.
        </div>
      ) : null}
    </div>
  );
}

function confidenceTooltip(confidence?: number): string {
  return typeof confidence === "number" ? `Confidence ${Math.round(confidence * 100)}%` : "Confidence unavailable";
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 502) return "The AI provider did not answer. Please try again in a moment.";
    if (err.status === 404) return "That patient could not be found in this clinic.";
    return err.message;
  }
  return "Request failed. Try again.";
}

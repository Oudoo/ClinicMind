"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import type { PatientOption } from "@/modules/consultations/types";

/**
 * Searchable patient select backed by `GET /api/patients?q=`. A combobox with
 * keyboard navigation; the chosen patient is shown as a chip with a Change
 * button so the selection is always explicit.
 */
export function PatientPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: PatientOption | null;
  onChange: (patient: PatientOption | null) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const inputId = `${id}-input`;
  const listId = `${id}-list`;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PatientOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const q = query.trim();
        const data = await apiFetch<{ patients: PatientOption[] }>(
          `/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`,
        );
        if (!cancelled) {
          setResults(data.patients.slice(0, 20));
          setActive(0);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load patients.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function select(patient: PatientOption) {
    onChange(patient);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const patient = results[active];
      if (open && patient) {
        e.preventDefault();
        select(patient);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (value) {
    return (
      <Field label="Patient" htmlFor={inputId}>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{value.fullName}</p>
            {value.phone ? <p className="font-mono text-xs text-muted-foreground">{value.phone}</p> : null}
          </div>
          <Button id={inputId} type="button" variant="ghost" size="sm" onClick={() => onChange(null)} disabled={disabled}>
            <X />
            Change
          </Button>
        </div>
      </Field>
    );
  }

  const activeOption = open ? results[active] : undefined;

  return (
    <Field label="Patient" htmlFor={inputId} hint="Search by name, phone or e-mail.">
      <div ref={rootRef} className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeOption ? `${listId}-${activeOption.id}` : undefined}
          autoComplete="off"
          placeholder="Search patients…"
          className="pl-9"
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching patients"
            className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg"
          >
            {loading && !results.length ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>
            ) : null}
            {error ? <li className="px-3 py-2 text-xs text-danger">{error}</li> : null}
            {!loading && !error && !results.length ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No patients match.</li>
            ) : null}
            {results.map((patient, i) => (
              <li key={patient.id} id={`${listId}-${patient.id}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
                    i === active && "bg-muted",
                  )}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => select(patient)}
                >
                  <span className="truncate font-medium">{patient.fullName}</span>
                  {patient.phone ? (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{patient.phone}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Field>
  );
}

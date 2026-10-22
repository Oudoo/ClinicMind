"use client";

import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { apiFetch } from "@/lib/http";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "./appointment-shared";

export interface PatientOption {
  id: string;
  fullName: string;
  phone?: string | null;
}

interface SearchResult {
  q: string;
  items: PatientOption[];
  failed: boolean;
}

/**
 * Search-as-you-type patient picker (combobox) over `GET /api/patients?q=`.
 * Arrow keys move through the matches, Enter picks one; a chosen patient is
 * shown with a "Change" control.
 */
export function PatientPicker({
  value,
  onChange,
  error,
}: {
  value: PatientOption | null;
  onChange: (patient: PatientOption | null) => void;
  error?: string;
}) {
  const id = useId();
  const inputId = `${id}-patient`;
  const listId = `${id}-listbox`;
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<SearchResult | null>(null);
  const debounced = useDebouncedValue(query.trim(), 250);

  useEffect(() => {
    if (!debounced) return;
    const controller = new AbortController();
    apiFetch<{ patients: PatientOption[] }>(`/api/patients?q=${encodeURIComponent(debounced)}`, {
      signal: controller.signal,
    })
      .then((res) => setResult({ q: debounced, items: res.patients.slice(0, 8), failed: false }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setResult({ q: debounced, items: [], failed: true });
      });
    return () => controller.abort();
  }, [debounced]);

  const current = result && result.q === debounced ? result : null;
  const items = current?.items ?? [];
  const open = focused && debounced.length > 0;
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const activeItem = items[activeIndex];

  function select(patient: PatientOption) {
    onChange(patient);
    setQuery("");
    setResult(null);
    setActive(0);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || !items.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeItem) select(activeItem);
    }
  }

  const hint = error ? <span className="text-danger">{error}</span> : undefined;

  if (value) {
    return (
      <Field label="Patient" htmlFor={inputId} hint={hint}>
        <div className="flex h-10 items-center justify-between gap-2 rounded-lg border border-input bg-muted px-3 text-sm">
          <span className="truncate font-medium">{value.fullName}</span>
          <button
            id={inputId}
            type="button"
            onClick={() => onChange(null)}
            aria-label={`Change patient (currently ${value.fullName})`}
            className="shrink-0 rounded text-xs text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Change
          </button>
        </div>
      </Field>
    );
  }

  return (
    <Field label="Patient" htmlFor={inputId} hint={hint}>
      <div className="relative">
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeItem ? `${listId}-${activeItem.id}` : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          placeholder="Search patients by name or phone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
        />
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label="Matching patients"
            className="absolute left-0 right-0 z-10 mt-1 max-h-56 overflow-auto rounded-lg border border-border bg-card p-1 shadow-lg"
          >
            {!current ? <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li> : null}
            {current?.failed ? <li className="px-3 py-2 text-xs text-danger">Search failed. Try again.</li> : null}
            {current && !current.failed && items.length === 0 ? (
              <li className="px-3 py-2 text-xs text-muted-foreground">No patients match “{debounced}”.</li>
            ) : null}
            {items.map((p, i) => (
              <li key={p.id} id={`${listId}-${p.id}`} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  tabIndex={-1}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(p)}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm",
                    i === activeIndex ? "bg-muted" : "hover:bg-muted",
                  )}
                >
                  <span className="truncate font-medium">{p.fullName}</span>
                  {p.phone ? (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{p.phone}</span>
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

"use client";

import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/**
 * Chip (token) input for short string lists: tags, allergies, diagnoses…
 * Enter or a comma adds what was typed, Backspace on an empty box removes the
 * last chip, and every chip carries its own remove button for keyboard users.
 * Duplicates (case-insensitive) are ignored; `max` caps the list.
 */
export function ChipInput({
  id,
  label,
  values,
  onChange,
  max,
  maxLength,
  placeholder,
  hint,
  error,
  disabled = false,
}: {
  id: string;
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  max: number;
  maxLength: number;
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const full = values.length >= max;

  function commit() {
    const value = draft.trim().replace(/\s+/g, " ");
    if (!value) return;
    setDraft("");
    if (full || values.some((v) => v.toLowerCase() === value.toLowerCase())) return;
    onChange([...values, value]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && draft === "" && values.length) {
      e.preventDefault();
      onChange(values.slice(0, -1));
    }
  }

  const counter = `${values.length}/${max}`;

  return (
    <Field
      label={label}
      htmlFor={id}
      hint={error ? <span className="text-danger">{error}</span> : (hint ?? counter)}
    >
      <div
        className={cn(
          "flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring",
          error && "border-danger",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-muted px-2 py-0.5 text-xs font-medium text-accent"
          >
            <span className="truncate">{value}</span>
            <button
              type="button"
              onClick={() => onChange(values.filter((v) => v !== value))}
              disabled={disabled}
              aria-label={`Remove ${value}`}
              className="rounded-sm text-accent/70 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
          maxLength={maxLength}
          placeholder={full ? "Maximum reached" : placeholder}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          className="h-7 min-w-[8rem] flex-1 bg-transparent px-1 text-sm placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
    </Field>
  );
}

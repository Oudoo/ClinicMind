"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Search-as-you-type for the inbox dialogs: waits `delayMs` after the last
 * keystroke, cancels the request a newer term replaces, and reports
 * `undefined` (nothing typed), `null` (searching) or the matches.
 */
export function useDebouncedSearch<T>(term: string, fetcher: (term: string, signal: AbortSignal) => Promise<T[]>, delayMs = 250): T[] | null | undefined {
  const latest = useRef(fetcher);
  useEffect(() => {
    latest.current = fetcher;
  });
  const wanted = term.trim();
  const [debounced, setDebounced] = useState(wanted);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(wanted), delayMs);
    return () => window.clearTimeout(timer);
  }, [wanted, delayMs]);
  const [result, setResult] = useState<{ term: string; items: T[] } | null>(null);
  useEffect(() => {
    if (!debounced) return;
    const controller = new AbortController();
    latest.current(debounced, controller.signal)
      .then((items) => setResult({ term: debounced, items }))
      .catch(() => {
        if (!controller.signal.aborted) setResult({ term: debounced, items: [] });
      });
    return () => controller.abort();
  }, [debounced]);
  if (!wanted) return undefined;
  return result && result.term === wanted ? result.items : null;
}

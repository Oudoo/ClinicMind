import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number | string, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(Number(value));
}

export function formatNumber(value: number | string) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, notation: "compact" }).format(
    Number(value)
  );
}

export function formatPct(value: number | string, digits = 1) {
  return `${Number(value).toFixed(digits)}%`;
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Server actions in this app return result objects for client-component
 * callers; <form action> requires void. This cast adapts an action for
 * direct form usage (React ignores the return value at runtime).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function formAction<A extends any[]>(
  action: (...args: A) => Promise<unknown>
): (...args: A) => Promise<void> {
  return action as unknown as (...args: A) => Promise<void>;
}

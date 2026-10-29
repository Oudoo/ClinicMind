import type { QuoteStatus } from "@prisma/client";

/**
 * Treatment plans and quotes: the vocabulary shared by the service, the API
 * and the client components (the editor, the patient's page, the signature
 * pad). No server imports.
 */

export const QUOTE_STATUSES = ["DRAFT", "SENT", "ACCEPTED", "DECLINED", "WITHDRAWN"] as const satisfies readonly QuoteStatus[];
export type QuoteStatusValue = (typeof QUOTE_STATUSES)[number];

/** How a quote stands: its status, a SENT one past its last valid day being EXPIRED. */
export type QuoteState = QuoteStatusValue | "EXPIRED";

export const QUOTE_STATE_LABELS: Record<QuoteState, string> = {
  DRAFT: "Draft",
  SENT: "Waiting for an answer",
  EXPIRED: "Expired",
  ACCEPTED: "Accepted",
  DECLINED: "Declined",
  WITHDRAWN: "Withdrawn",
};

export const QUOTE_LANGUAGES = ["en", "ar"] as const;
export type QuoteLanguage = (typeof QUOTE_LANGUAGES)[number];

/** A quote holds this many days unless set otherwise, and at most a year. */
export const QUOTE_VALID_DAYS = 30;
export const QUOTE_MAX_VALID_DAYS = 365;

export const MAX_PHASES = 6;
export const MAX_ITEMS = 40;

/** How a quote stands on a day: a SENT quote whose last valid day has passed is expired. Day keys are YYYY-MM-DD on the clinic clock. */
export function quoteState(status: QuoteStatusValue, validUntilKey: string, todayKey: string): QuoteState {
  return status === "SENT" && todayKey > validUntilKey ? "EXPIRED" : status;
}

/** A visit and a course package count as one; other units by how many. */
export function countedUnit(unit: string): boolean {
  return unit !== "VISIT" && unit !== "PACKAGE";
}

/** What items come to: before discounts, the discounts, and after them. */
export function quoteTotals(items: readonly { price: number; discount: number }[]): { list: number; discount: number; total: number } {
  let list = 0;
  let discount = 0;
  for (const i of items) {
    list += i.price;
    discount += i.discount;
  }
  return { list, discount, total: list - discount };
}

/** "60%" of a part, or "–" of nothing. */
export function rate(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part * 100) / whole)}%` : "–";
}

// ── The signature ────────────────────────────────────────────────────────────

/** The pad's drawing space; the path is stored in it, whatever size the pad was on screen. */
export const SIGNATURE_WIDTH = 600;
export const SIGNATURE_HEIGHT = 200;
export const SIGNATURE_MAX_LENGTH = 40_000;

/**
 * A signature as the pad sends it: an SVG path of moves and lines in whole
 * numbers inside the pad ("M12,40 L14,41 …"). Returns it tidied, or null
 * when it is anything else, or too little to be a signature (a dot or a
 * click): at least eight points spanning 30 units one way or the other.
 */
export function cleanSignature(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text || text.length > SIGNATURE_MAX_LENGTH) return null;
  const tokens = text.split(/\s+/);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [i, token] of tokens.entries()) {
    const m = /^([ML])(\d{1,3}),(\d{1,3})$/.exec(token);
    if (!m || (i === 0 && m[1] !== "M")) return null;
    const x = Number(m[2]);
    const y = Number(m[3]);
    if (x > SIGNATURE_WIDTH || y > SIGNATURE_HEIGHT) return null;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (tokens.length < 8 || (maxX - minX < 30 && maxY - minY < 30)) return null;
  return tokens.join(" ");
}

/** Strokes drawn on the pad (points in its drawing space) as the path stored. */
export function strokesToPath(strokes: readonly (readonly { x: number; y: number }[])[]): string {
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  return strokes
    .filter((s) => s.length > 0)
    .map((s) => s.map((p, i) => `${i === 0 ? "M" : "L"}${clamp(p.x, SIGNATURE_WIDTH)},${clamp(p.y, SIGNATURE_HEIGHT)}`).join(" "))
    .join(" ");
}

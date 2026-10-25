/**
 * Deterministic randomness for the seed modules. Each module creates its own
 * stream with a fixed seed so re-running the seed rebuilds the same clinic.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Random {
  rand: () => number;
  pick: <T>(items: readonly T[]) => T;
  between: (min: number, max: number) => number;
  chance: (p: number) => boolean;
  /** Pick by weight: `weighted([["a", 0.7], ["b", 0.3]])`. */
  weighted: <T>(items: readonly (readonly [T, number])[]) => T;
}

export function makeRandom(seed: number): Random {
  const rand = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const chance = (p: number) => rand() < p;
  const weighted = <T>(items: readonly (readonly [T, number])[]): T => {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = rand() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1]![0];
  };
  return { rand, pick, between, chance, weighted };
}

const DAY_MS = 86_400_000;

/** An instant `days` before `from` (fractional days allowed), at the same clock time. */
export function daysBefore(from: Date, days: number): Date {
  return new Date(from.getTime() - days * DAY_MS);
}

export function daysAfter(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Egyptian mobile number, deterministic from the stream. */
export function egyptianMobile(r: Random): string {
  return `+201${r.pick(["0", "1", "2", "5"])}${String(r.between(10_000_000, 99_999_999))}`;
}

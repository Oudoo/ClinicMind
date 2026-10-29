import { crc32, deflateSync } from "node:zlib";

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

/** A small RGB PNG drawn pixel by pixel (no image library in the seed). */
export function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw.set([r, g, b], row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

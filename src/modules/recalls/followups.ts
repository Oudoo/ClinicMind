import { normalizeText } from "@/modules/assistant/text";

/**
 * A follow-up the doctor stated in a signed consultation ("Review in 6
 * weeks", "follow up 3/12", "متابعة بعد أسبوعين") becomes a recall on the day
 * it names. Only a stated return with a stated time counts: "refer to
 * endocrinology" or "come back if it gets worse" name no day, so nothing is
 * made from them, and a time in the past ("itching for 2 weeks", "منذ شهر")
 * is not a return. Pure, so it is tested on its own.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  واحد: 1,
  اثنين: 2,
  اتنين: 2,
  ثلاث: 3,
  ثلاثه: 3,
  تلات: 3,
  تلاته: 3,
  اربع: 4,
  اربعه: 4,
  خمس: 5,
  خمسه: 5,
  ست: 6,
  سته: 6,
  سبع: 7,
  سبعه: 7,
  ثمان: 8,
  ثمانيه: 8,
  تمن: 8,
  تمانيه: 8,
  تسع: 9,
  تسعه: 9,
  عشر: 10,
  عشره: 10,
};

const UNITS: [string, number][] = [
  ["days|day|d", 1],
  ["weeks|week|wks|wk", 7],
  ["months|month|mths|mth|mos|mo", 30],
  ["years|year|yrs|yr", 365],
  ["ايام|يوما|يوم", 1],
  ["اسابيع|اسبوعا|اسبوع", 7],
  ["شهور|اشهر|شهرا|شهر", 30],
  ["سنوات|سنين|سنه|عام", 365],
];
const DUALS: Record<string, number> = { يومين: 2, اسبوعين: 14, شهرين: 60, سنتين: 730 };

// Boundaries that work for Arabic too (\b only knows ASCII letters).
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const NUM = `(\\d{1,3}|${Object.keys(WORD_NUMBERS).join("|")})`;
const UNIT = `(${UNITS.map(([u]) => u).join("|")})`;
const SPAN = new RegExp(`${B}${NUM}(?:\\s*(?:-|to|or|او|الى|ل)\\s*${NUM})?\\s*${UNIT}${E}`, "gu");
const DUAL = new RegExp(`${B}(${Object.keys(DUALS).join("|")})${E}`, "gu");
const BARE = new RegExp(`${B}(?:in|after|within|next|بعد|خلال|كمان)\\s+(?:(?:a|an|one|واحد)\\s+)?${UNIT}${E}`, "gu");
const SHORTHAND = /(?<![\d/])(\d{1,2})\s*\/\s*(52|12|7)(?![\d/])/gu;

/** Before the time: it is ahead ("in 6 weeks", "بعد شهر"). */
const AHEAD = /(?:^|[^\p{L}])(in|after|within|next|every|بعد|خلال|كمان|كل)\s*$/u;
/** Before the time: it is behind ("for 2 weeks", "منذ شهر", "since"). */
const BEHIND = /(?:^|[^\p{L}])(for|since|منذ|من|بقاله|بقالها|لمده)\s*$/u;
/** After the time: it is behind ("2 weeks ago"). */
const AGO = /^\s*(ago|back|فاتوا|فاتت)/u;
/** Words that make a time a return to the clinic. */
const RETURN = /(?:^|[^\p{L}])(review|follow|f\/u|return|come back|recall|revisit|re-?evaluate|re-?assess|recheck|check|see|session|visit|appointment|control|repeat|injection|inject|top-?up|booster|متابعه|مراجعه|ميعاد|موعد|كشف|استشاره|جلسه|زياره|يرجع|ترجع|رجوع|يعود|اعاده|حقن|حقنه)(?:[^\p{L}]|$)/u;

const MIN_DAYS = 1;
const MAX_DAYS = 730;

interface Found {
  index: number;
  length: number;
  days: number;
}

function unitDays(unit: string): number {
  return UNITS.find(([u]) => new RegExp(`^(${u})$`, "u").test(unit))?.[1] ?? 0;
}

function numberOf(word: string): number {
  return /^\d+$/.test(word) ? Number(word) : (WORD_NUMBERS[word] ?? NaN);
}

function times(t: string): Found[] {
  const found: Found[] = [];
  for (const m of t.matchAll(SPAN)) found.push({ index: m.index, length: m[0].length, days: numberOf(m[1]!) * unitDays(m[3]!) });
  for (const m of t.matchAll(DUAL)) found.push({ index: m.index, length: m[0].length, days: DUALS[m[1]!]! });
  for (const m of t.matchAll(BARE)) found.push({ index: m.index, length: m[0].length, days: unitDays(m[1]!) });
  for (const m of t.matchAll(SHORTHAND)) {
    const per = m[2] === "52" ? 7 : m[2] === "12" ? 30 : 1;
    found.push({ index: m.index, length: m[0].length, days: Number(m[1]) * per });
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Days until the return the text states, or null when it states none.
 * A range takes its first figure ("6-8 weeks" → 42): the recall's window
 * covers the rest.
 */
export function followUpDays(text: string): number | null {
  if (!text) return null;
  const t = normalizeText(text).replace(/[–—]/g, "-");
  if (!RETURN.test(t)) return null;
  let fallback: number | null = null;
  for (const f of times(t)) {
    if (!Number.isFinite(f.days) || f.days < MIN_DAYS || f.days > MAX_DAYS) continue;
    const before = t.slice(Math.max(0, f.index - 24), f.index);
    const after = t.slice(f.index + f.length, f.index + f.length + 12);
    if (BEHIND.test(before) || AGO.test(after)) continue;
    // "In 6 weeks" / "بعد شهر" is a return for sure; "6 weeks review" / "3/12" counts when nothing better is stated.
    if (AHEAD.test(before) || /^(in|after|within|بعد|خلال)\b/u.test(t.slice(f.index, f.index + 6))) return Math.round(f.days);
    fallback ??= Math.round(f.days);
  }
  return fallback;
}

/** The window a stated follow-up stays on time: a quarter of the wait, between 3 days and 2 weeks. */
export function followUpWindow(days: number): number {
  return Math.min(14, Math.max(3, Math.round(days / 4)));
}

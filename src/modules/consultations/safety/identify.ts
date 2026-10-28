import {
  COMBINATIONS,
  FORM_WORDS,
  INGREDIENTS,
  INJECTION_WORDS,
  ORAL_WORDS,
  TOPICAL_WORDS,
  routeGroup,
  type Ingredient,
  type Route,
} from "./knowledge";

/**
 * Reading a prescription line: which ingredients a name stands for (brand →
 * generic, spelling variants, combinations), which route it is given by, a
 * stable key for "the same medication", and the daily dose in mg when it can
 * be worked out. Pure and client-safe.
 */

export interface MedicationText {
  name: string;
  dosage?: string | null;
  frequency?: string | null;
}

export interface IdentifiedMedication {
  /** Ingredients found in the name (empty for a medicine the table does not know). */
  ingredients: Ingredient[];
  /** A combination product's name, e.g. "Amoxicillin + clavulanic acid". */
  combination: string | null;
  route: Route;
  /** The name without strengths, forms and punctuation ("minoxidil" for "Minoxidil 5% solution"). */
  baseName: string;
  /** Reconciliation key: the generic(s), plus "@topical" for a topical form. */
  key: string;
}

// ── Text ─────────────────────────────────────────────────────────────────────

const ARABIC_MARKS = /[ً-ْٰـ]/g;
const ARABIC_LETTER = /[؀-ۿ]/;

/** Lower-case, NFKC, Arabic letters unified (أإآ → ا, ة → ه, ى → ي), Arabic digits → 0-9, spaces collapsed. */
export function normaliseText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(ARABIC_MARKS, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/[µμ]/g, "u")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normaliseText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Token equality that lets an Arabic word carry the definite article ("البنسلين" ≡ "بنسلين"). */
export function sameToken(actual: string, expected: string): boolean {
  return actual === expected || (ARABIC_LETTER.test(expected) && actual === `ال${expected}`);
}

/** True when `needle` occurs as consecutive tokens of `haystack`. */
export function containsTokens(haystack: readonly string[], needle: readonly string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let k = 0; k < needle.length; k++) if (!sameToken(haystack[i + k]!, needle[k]!)) continue outer;
    return true;
  }
  return false;
}

const UNIT = String.raw`%|mgs?|milligrams?|mcg|ug|micrograms?|g|gm|gms|grams?|kg|mls?|millilit(?:er|re)s?|l|iu|units?|w\/w|w\/v`;
const STRENGTH = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(?:${UNIT})?(?:\s*\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:ml|g|l|kg|dose|tabs?|tablets?|caps?|capsules?|day|d|h|hr|hours?|m2))?(?![\p{L}])`,
  "gu",
);
const MULTIPLIER = /\d+(?:[.,]\d+)?\s*[x×]\s*(?=\d)/gu;
const FORM_SET = new Set(FORM_WORDS);

/** Name without strengths, dosage forms and punctuation: "Minoxidil 5% solution" → "minoxidil". */
export function baseMedicationName(name: string): string {
  const stripped = normaliseText(name).replace(MULTIPLIER, " ").replace(STRENGTH, " ");
  return tokenize(stripped)
    .filter((t) => !FORM_SET.has(t))
    .join(" ");
}

// ── Alias index ──────────────────────────────────────────────────────────────

interface AliasTarget {
  ingredients: readonly Ingredient[];
  route?: Route;
  combination?: string;
}

interface AliasEntry {
  tokens: readonly string[];
  target: AliasTarget;
}

interface AliasIndex {
  byFirstToken: Map<string, AliasEntry[]>;
  /** Single-token aliases long enough for a one-letter typo tolerance. */
  fuzzy: { token: string; target: AliasTarget }[];
  byKey: Map<string, Ingredient>;
}

/** Tokens at least this long tolerate one typo ("amoxicilin", "doxycyclin"). */
const FUZZY_MIN_LENGTH = 7;

let aliasIndex: AliasIndex | null = null;

function index(): AliasIndex {
  if (aliasIndex) return aliasIndex;
  const byKey = new Map(INGREDIENTS.map((i) => [i.key, i] as const));
  const byFirstToken = new Map<string, AliasEntry[]>();
  const fuzzy: AliasIndex["fuzzy"] = [];
  const add = (alias: string, target: AliasTarget) => {
    const tokens = tokenize(alias);
    if (!tokens.length) return;
    const list = byFirstToken.get(tokens[0]!) ?? [];
    list.push({ tokens, target });
    byFirstToken.set(tokens[0]!, list);
    if (ARABIC_LETTER.test(tokens[0]!)) {
      const withArticle = [`ال${tokens[0]}`, ...tokens.slice(1)];
      const articled = byFirstToken.get(withArticle[0]!) ?? [];
      articled.push({ tokens: withArticle, target });
      byFirstToken.set(withArticle[0]!, articled);
    }
    if (tokens.length === 1 && tokens[0]!.length >= FUZZY_MIN_LENGTH) fuzzy.push({ token: tokens[0]!, target });
  };
  for (const ingredient of INGREDIENTS) {
    for (const alias of ingredient.aliases ?? []) {
      if (typeof alias === "string") add(alias, { ingredients: [ingredient] });
      else add(alias.name, { ingredients: [ingredient], route: alias.route });
    }
  }
  for (const combination of COMBINATIONS) {
    const ingredients = combination.ingredients.map((key) => byKey.get(key)).filter((i): i is Ingredient => Boolean(i));
    for (const alias of combination.aliases) add(alias, { ingredients, route: combination.route, combination: combination.name });
  }
  // Longest alias first, so "penicillin v" wins over "penicillin".
  for (const list of byFirstToken.values()) list.sort((a, b) => b.tokens.length - a.tokens.length);
  aliasIndex = { byFirstToken, fuzzy, byKey };
  return aliasIndex;
}

export function ingredientByKey(key: string): Ingredient | undefined {
  return index().byKey.get(key);
}

/** At most one insertion, deletion or substitution apart. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

function fuzzyTarget(token: string): AliasTarget | null {
  if (token.length < FUZZY_MIN_LENGTH || FORM_SET.has(token)) return null;
  let found: AliasTarget | null = null;
  for (const entry of index().fuzzy) {
    if (!withinOneEdit(token, entry.token)) continue;
    // Two different medicines one letter away: too ambiguous to guess.
    if (found && found.ingredients.map((i) => i.key).join() !== entry.target.ingredients.map((i) => i.key).join()) return null;
    found = entry.target;
  }
  return found;
}

/** Every known medicine named in the tokens, longest alias first, typos tolerated on long words. */
export function matchAliases(tokens: readonly string[]): AliasTarget[] {
  const out: AliasTarget[] = [];
  const { byFirstToken } = index();
  for (let i = 0; i < tokens.length; ) {
    const candidates = byFirstToken.get(tokens[i]!) ?? [];
    const hit = candidates.find((c) => c.tokens.every((t, k) => tokens[i + k] === t));
    if (hit) {
      out.push(hit.target);
      i += hit.tokens.length;
      continue;
    }
    const fuzzy = fuzzyTarget(tokens[i]!);
    if (fuzzy) out.push(fuzzy);
    i++;
  }
  return out;
}

/** Ingredients named anywhere in a free text (an allergy, a summary). */
export function ingredientsIn(text: string): Ingredient[] {
  const seen = new Map<string, Ingredient>();
  for (const target of matchAliases(tokenize(text))) for (const i of target.ingredients) seen.set(i.key, i);
  return [...seen.values()];
}

// ── Route ────────────────────────────────────────────────────────────────────

const INJECTION_SET = new Set(INJECTION_WORDS);
const ORAL_SET = new Set(ORAL_WORDS);
const TOPICAL_SET = new Set(TOPICAL_WORDS);
const MASS_HINT = /\d\s*(mg|mcg|ug|g|gm)(?![\p{L}])/u;

function inferRoute(med: MedicationText, ingredients: readonly Ingredient[], aliasRoute: Route | undefined): Route {
  const text = normaliseText([med.name, med.dosage ?? "", med.frequency ?? ""].join(" "));
  const tokens = new Set(tokenize(text));
  const any = (set: Set<string>) => [...tokens].some((t) => set.has(t));
  if (any(INJECTION_SET)) return "injection";
  if (any(ORAL_SET)) return "oral";
  if (any(TOPICAL_SET) || text.includes("%")) return "topical";
  if (aliasRoute) return aliasRoute;
  const first = ingredients[0];
  if (!first) return "oral";
  const canBeOral = first.route === "oral" || Boolean(first.alsoRoutes?.includes("oral"));
  if (MASS_HINT.test(text) && canBeOral) return "oral";
  return first.route;
}

// ── Identification ───────────────────────────────────────────────────────────

const identified = new Map<string, IdentifiedMedication>();

export function identifyMedication(med: MedicationText): IdentifiedMedication {
  const cacheKey = `${med.name}\u0000${med.dosage ?? ""}\u0000${med.frequency ?? ""}`;
  const cached = identified.get(cacheKey);
  if (cached) return cached;

  const targets = matchAliases(tokenize(normaliseText(med.name).replace(MULTIPLIER, " ").replace(STRENGTH, " ")));
  const byKey = new Map<string, Ingredient>();
  for (const target of targets) for (const ingredient of target.ingredients) byKey.set(ingredient.key, ingredient);
  const ingredients = [...byKey.values()];
  const aliasRoute = targets.find((t) => t.route)?.route;
  const route = inferRoute(med, ingredients, aliasRoute);
  const baseName = baseMedicationName(med.name);
  const combination = targets.length === 1 && targets[0]!.combination ? targets[0]!.combination : ingredients.length > 1 ? ingredients.map((i) => i.name).join(" + ") : null;
  const generic = ingredients.map((i) => i.key).sort().join("+");
  const key = generic ? (routeGroup(route) === "topical" ? `${generic}@topical` : generic) : baseName || normaliseText(med.name);

  const result: IdentifiedMedication = { ingredients, combination, route, baseName, key };
  if (identified.size > 2000) identified.clear();
  identified.set(cacheKey, result);
  return result;
}

/**
 * The key under which two prescription lines count as the same medication:
 * "Minoxidil 5%" ≡ "Minoxidil 5% solution" ≡ "Regaine" (topical minoxidil),
 * "Roaccutane 20 mg" ≡ "Isotretinoin". Oral and topical forms of one generic
 * stay distinct (oral minoxidil is not the scalp solution).
 */
export function medicationKey(med: MedicationText): string {
  return identifyMedication(med).key;
}

// ── Dose ─────────────────────────────────────────────────────────────────────

const MASS = /(\d+(?:[.,]\d+)?)\s*(mgs?|milligrams?|mcg|ug|micrograms?|g|gm|gms|grams?)(?![\p{L}])(?!\s*\/\s*\d*(?:[.,]\d+)?\s*(?:ml|l|g|gm|kg)(?![\p{L}]))/u;
const MULTIPLIED_MASS = /(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(mgs?|milligrams?|mcg|ug|micrograms?|g|gm|gms|grams?)(?![\p{L}])/u;
const COUNT = /(\d+(?:[.,]\d+)?|½|half|one|two|three|four)\s*(?:x\s*)?(tabs?|tablets?|caps?|capsules?|pills?|sachets?|softgels?|قرص|اقراص|كبسوله|كبسولات)(?![\p{L}])/u;
const PER_DAY = /(\/\s*(day|d|24\s*h)(?![\p{L}])|per\s+day|a\s+day|per\s+24|daily\s+total|total\s+daily)/u;
const WORD_NUMBERS: Record<string, number> = { "½": 0.5, half: 0.5, once: 1, one: 1, twice: 2, two: 2, thrice: 3, three: 3, four: 4, five: 5, six: 6 };

const num = (s: string): number => WORD_NUMBERS[s] ?? Number(s.replace(",", "."));

function toMg(value: number, unit: string): number {
  if (/^(g|gm|gms|grams?)$/.test(unit)) return value * 1000;
  if (/^(mcg|ug|micrograms?)$/.test(unit)) return value / 1000;
  return value;
}

function massIn(text: string): number | null {
  const m = MASS.exec(text);
  return m ? toMg(num(m[1]!), m[2]!) : null;
}

const N = String.raw`(\d+(?:\.\d+)?|once|one|twice|two|thrice|three|four|five|six)`;
const FREQUENCY_RULES: [RegExp, (m: RegExpExecArray) => number][] = [
  // 1-0-1 (morning-noon-night tablets)
  [/(?:^|[^\d.])(\d)\s*-\s*(\d)\s*-\s*(\d)(?:\s*-\s*(\d))?(?![\d])/u, (m) => num(m[1]!) + num(m[2]!) + num(m[3]!) + (m[4] ? num(m[4]) : 0)],
  [new RegExp(String.raw`${N}\s*(?:x|times?)?\s*(?:a|per|each|every|\/)\s*week(?![\p{L}])`, "u"), (m) => num(m[1]!) / 7],
  [new RegExp(String.raw`${N}\s*(?:x|times?)?\s*weekly`, "u"), (m) => num(m[1]!) / 7],
  [/every\s+other\s+week|fortnightly/u, () => 1 / 14],
  [/every\s+(\d+)\s*weeks?/u, (m) => 1 / (7 * num(m[1]!))],
  [/\bweekly\b|every\s+week|every\s+(mon|tues|wednes|thurs|fri|satur|sun)day|اسبوعيا|اسبوعي/u, () => 1 / 7],
  [/every\s+(\d+)\s*months?/u, (m) => 1 / (30 * num(m[1]!))],
  [/\bmonthly\b|every\s+month|once\s+a\s+month/u, () => 1 / 30],
  [/every\s+other\s+day|alternate\s+days?|\beod\b|\bqod\b|every\s+second\s+day/u, () => 0.5],
  [/every\s+(\d+)\s*days/u, (m) => 1 / num(m[1]!)],
  [/(?:every|q)\s*(\d+(?:\.\d+)?)\s*(?:-\s*\d+\s*)?(?:h|hr|hrs|hours?)(?![\p{L}])/u, (m) => Math.min(24, 24 / num(m[1]!))],
  [/(\d+)\s*-?\s*hourly/u, (m) => Math.min(24, 24 / num(m[1]!))],
  [new RegExp(String.raw`${N}\s*(?:x|times?)\s*(?:a|per|\/|each|every)?\s*(?:day|daily|d)(?![\p{L}])`, "u"), (m) => num(m[1]!)],
  [new RegExp(String.raw`${N}\s*times(?![\p{L}])`, "u"), (m) => num(m[1]!)],
  // "x2" — but not "daily x 8 weeks" (a duration).
  [/\bx\s*(\d)(?![\d.])(?!\s*(?:weeks?|wks?|days?|months?|d\b))/u, (m) => num(m[1]!)],
  [/\b(qid|qds|q\.i\.d|q\.d\.s)\b|four\s+times|4\s+مرات|اربع\s+مرات/u, () => 4],
  [/\b(tid|tds|t\.i\.d|t\.d\.s)\b|three\s+times|thrice|3\s+مرات|ثلاث\s+مرات/u, () => 3],
  [/\b(bid|bd|b\.i\.d|b\.d)\b|twice|two\s+times|morning\s+and\s+(evening|night)|مرتين/u, () => 2],
  [/\b(od|qd|q\.d|daily|once|nightly|nocte|mane|qhs|hs|qam|qpm|stat)\b|every\s+(day|morning|evening|night)|at\s+(night|bedtime)|in\s+the\s+(morning|evening)|per\s+day|a\s+day|single\s+dose|يوميا|مره/u, () => 1],
];

/** How many doses a day a frequency means (1/7 for weekly); null when it cannot be told. */
export function dosesPerDay(text: string | null | undefined): number | null {
  const t = normaliseText(text ?? "");
  if (!t) return null;
  for (const [pattern, value] of FREQUENCY_RULES) {
    const m = pattern.exec(t);
    if (m) {
      const n = value(m);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  }
  return null;
}

export interface DailyDose {
  /** One dose, in mg. */
  perDoseMg: number;
  /** Null when the frequency could not be read (the daily dose then assumes one dose). */
  dosesPerDay: number | null;
  dailyMg: number;
}

/**
 * The daily dose in mg of a single-ingredient line, from the dosage, the
 * strength in the name ("Doxycycline 100 mg" + "2 tablets") and the
 * frequency ("twice daily", "BID", "1-0-1", "every 8 hours", "weekly").
 * Null when no mass can be found (topical "thin layer", "1 ml", mg/kg).
 */
export function dailyDose(med: MedicationText): DailyDose | null {
  const dosage = normaliseText(med.dosage ?? "");
  const name = normaliseText(med.name);
  if (/mg\s*\/\s*kg/u.test(dosage)) return null;

  let perDose: number | null = null;
  const multiplied = MULTIPLIED_MASS.exec(dosage);
  const dosageMass = massIn(dosage);
  const countMatch = COUNT.exec(dosage);
  const count = countMatch ? num(countMatch[1]!) : null;
  const nameMass = massIn(name);
  if (multiplied) perDose = num(multiplied[1]!) * toMg(num(multiplied[2]!), multiplied[3]!);
  else if (count !== null && dosageMass !== null && /\b(of|each)\b/u.test(dosage)) perDose = count * dosageMass;
  else if (dosageMass !== null) perDose = dosageMass;
  else if (nameMass !== null) perDose = (count ?? 1) * nameMass;
  if (perDose === null || !(perDose > 0)) return null;

  const frequencyText = normaliseText(med.frequency ?? "");
  // "40 mg/day" in the dosage is already a daily total.
  if (!frequencyText && dosageMass !== null && PER_DAY.test(dosage) && dosesPerDay(dosage.replace(PER_DAY, " ")) === null) {
    return { perDoseMg: perDose, dosesPerDay: 1, dailyMg: perDose };
  }
  const perDay = dosesPerDay(frequencyText) ?? (frequencyText ? null : dosesPerDay(dosage));
  return { perDoseMg: perDose, dosesPerDay: perDay, dailyMg: perDose * (perDay ?? 1) };
}

/** "120 mg", "1.5 g", "0.5 mg". */
export function formatMg(mg: number): string {
  if (mg >= 1000 && mg % 100 === 0) return `${mg / 1000} g`;
  return `${Math.round(mg * 100) / 100} mg`;
}

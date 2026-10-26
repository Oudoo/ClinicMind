/**
 * Pure helpers behind the patient search box and the intake form's phone
 * handling. No database, no framework: the route tests exercise them directly.
 *
 * Egyptian numbers arrive in many spellings — "010 1234 5678", "+20 10 1234
 * 5678", "0020101…", often typed with Arabic-Indic digits (٠١٢…) — and the
 * registry stores them in whatever form the front desk entered. Everything
 * here normalises towards the `+2010…` form the seed and the WhatsApp
 * integration use, while the lookup still tries every spelling.
 */

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXTENDED_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** Replace Arabic-Indic (and Persian) digits with ASCII 0-9; everything else is kept. */
export function normalizeDigits(value: string): string {
  let out = "";
  for (const ch of value) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a !== -1) {
      out += String(a);
      continue;
    }
    const e = EXTENDED_ARABIC_INDIC.indexOf(ch);
    out += e !== -1 ? String(e) : ch;
  }
  return out;
}

/** Only the digits of a value, Arabic-Indic digits included. */
export function digitsOnly(value: string): string {
  return normalizeDigits(value).replace(/\D/g, "");
}

/** True when the text is made of digits and phone punctuation only (after digit normalisation). */
export function isNumericQuery(value: string): boolean {
  const v = normalizeDigits(value).trim();
  return v.length > 0 && /^\+?[\d\s().-]+$/.test(v) && digitsOnly(v).length >= 3;
}

/**
 * Every spelling under which a phone number may have been stored:
 * `+2010…`, `010…`, `2010…` and `0020…`. The input may be any of them.
 * Numbers that are not Egyptian mobiles get the bare and `+` forms only.
 */
export function phoneVariants(value: string): string[] {
  let d = digitsOnly(value);
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length < 7 || d.length > 15) return [];
  const variants = new Set<string>();
  const add = (local10: string) => {
    variants.add(`+20${local10}`);
    variants.add(`0${local10}`);
    variants.add(`20${local10}`);
    variants.add(`0020${local10}`);
  };
  if (d.length === 12 && d.startsWith("20")) add(d.slice(2));
  else if (d.length === 11 && d.startsWith("0")) add(d.slice(1));
  else if (d.length === 10 && d.startsWith("1")) add(d);
  variants.add(`+${d}`);
  variants.add(d);
  return [...variants];
}

/** True when the digits form a plausible phone number (7–15 digits). */
export function looksLikePhone(value: string): boolean {
  const d = digitsOnly(value).replace(/^00/, "");
  return isNumericQuery(value) && d.length >= 7 && d.length <= 15;
}

/**
 * Canonical storage form for a phone typed by a patient: Arabic digits
 * converted, punctuation dropped, Egyptian mobiles written as `+2010…`,
 * `00` prefixes turned into `+`. Null when it cannot be a phone number.
 */
export function canonicalPhone(value: string): string | null {
  const raw = normalizeDigits(value).trim();
  if (!raw) return null;
  const hadPlus = raw.startsWith("+") || raw.startsWith("00");
  const d = digitsOnly(raw).replace(/^00/, "");
  if (d.length < 7 || d.length > 15) return null;
  if (d.length === 11 && d.startsWith("0") && !hadPlus) return `+20${d.slice(1)}`;
  if (d.length === 10 && d.startsWith("1") && !hadPlus) return `+20${d}`;
  if (d.length === 12 && d.startsWith("20")) return `+${d}`;
  return hadPlus ? `+${d}` : d;
}

/** Normalised national id / passport number: digits converted, spaces removed. */
export function normalizeNationalId(value: string): string {
  return normalizeDigits(value).replace(/\s+/g, "").trim();
}

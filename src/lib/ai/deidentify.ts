import { toAsciiDigits } from "@/modules/assistant/text";

/**
 * Nothing that reaches an AI provider carries a patient's name, phone or
 * WhatsApp number, national ID, e-mail or date of birth (Phase 4).
 *
 * Each patient named in a text becomes a label: "the patient" when the text
 * is about one patient, "Patient A", "Patient B"… when it is about several, so
 * the model's answer can be read back with the real names on the clinic's
 * side. A name word two patients share becomes "[name]". Any e-mail address
 * and any run of eight digits or more (a phone, an ID), whoever they belong
 * to, become "[email]" and "[number]"; the patient's date of birth becomes
 * "[date of birth]". Staff names stay ("Dr. Layla Hassan" is not "Patient A"
 * because a patient is called Hassan), and so do dates and doses: they are
 * what the question is about.
 *
 * No server imports: the evidence panel uses it in the browser too.
 */

export interface Identity {
  id?: string;
  fullName: string;
  phone?: string | null;
  whatsapp?: string | null;
  nationalId?: string | null;
  email?: string | null;
  dateOfBirth?: Date | null;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const NUMBER_RUN = /\+?\d[\d\s-]{6,}\d/g;
const MIN_DIGITS = 8;
const SHIELD = "\u0001";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const whole = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(s).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");

/** The words of a name worth matching alone: three letters or more ("Al", "El" are not). */
export function nameWords(fullName: string): string[] {
  return fullName
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^\p{L}'’]/gu, ""))
    .filter((w) => w.length >= 3);
}

/** "Patient A" … "Patient Z", "Patient AA" …: the labels of several patients. */
export function patientLabel(index: number): string {
  let n = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Patient ${letters}`;
}

const dayKeys = (d: Date) => {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return [`${y}-${m}-${day}`, `${day}/${m}/${y}`, `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${y}`];
};

/** Any e-mail address and any run of eight digits or more, whoever's: out. Dates stay. */
export function scrubNumbers(text: string): string {
  const dates: string[] = [];
  const shielded = toAsciiDigits(text).replace(ISO_DATE, (d) => `${SHIELD}${dates.push(d) - 1}${SHIELD}`);
  return shielded
    .replace(EMAIL, "[email]")
    .replace(NUMBER_RUN, (run) => (run.replace(/\D/g, "").length >= MIN_DIGITS ? "[number]" : run))
    .replace(new RegExp(`${SHIELD}(\\d+)${SHIELD}`, "g"), (_, i: string) => dates[Number(i)]!);
}

export class Pseudonyms {
  private readonly people: { identity: Identity; label: string }[];
  private readonly keep: string[];

  /**
   * `people`: the patients the text may name, in the order their labels are
   * given. `single`: one patient, called "the patient". `keep`: staff names
   * left as they are.
   */
  constructor(people: Identity[], opts: { single?: boolean; keep?: string[] } = {}) {
    const unique = people.filter((p, i) => p.fullName.trim() && people.findIndex((q) => (q.id ?? q.fullName) === (p.id ?? p.fullName)) === i);
    this.people = unique.map((identity, i) => ({ identity, label: opts.single ? "the patient" : patientLabel(i) }));
    this.keep = [...new Set((opts.keep ?? []).map((k) => k.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  }

  /** The label a patient goes by in what is sent, by id. */
  labelOf(id: string): string | null {
    return this.people.find((p) => p.identity.id === id)?.label ?? null;
  }

  /** The text as it may leave the clinic. */
  scrub(text: string): string {
    if (!text) return text;
    // Staff names first, out of reach of the patients' name words.
    const kept: string[] = [];
    let out = toAsciiDigits(text);
    for (const name of this.keep) out = out.replace(whole(name), (m) => `${SHIELD}k${kept.push(m) - 1}${SHIELD}`);

    for (const { identity } of this.people) {
      if (identity.dateOfBirth) for (const key of dayKeys(identity.dateOfBirth)) out = out.replace(whole(key), "[date of birth]");
      for (const exact of [identity.email, identity.phone, identity.whatsapp, identity.nationalId]) {
        if (exact && exact.trim().length >= 5) out = out.replace(whole(toAsciiDigits(exact.trim())), exact.includes("@") ? "[email]" : "[number]");
      }
    }
    out = scrubNumbers(out);

    // Whole names, longest first; then each name word, its owner's label when only one patient has it.
    const byLength = [...this.people].sort((a, b) => b.identity.fullName.length - a.identity.fullName.length);
    for (const { identity, label } of byLength) out = out.replace(whole(identity.fullName.trim()), label);
    const owners = new Map<string, Set<string>>();
    for (const { identity, label } of this.people) {
      for (const w of nameWords(identity.fullName)) {
        const key = w.toLowerCase();
        owners.set(key, (owners.get(key) ?? new Set()).add(label));
      }
    }
    for (const [w, labels] of [...owners].sort((a, b) => b[0].length - a[0].length)) {
      out = out.replace(whole(w), labels.size === 1 ? [...labels][0]! : "[name]");
    }
    // "the patient the patient" (first and last name in a row) reads once.
    out = out.replace(/(the patient|Patient [A-Z]+)(\s+\1)+/g, "$1");

    return out.replace(new RegExp(`${SHIELD}k(\\d+)${SHIELD}`, "g"), (_, i: string) => kept[Number(i)]!);
  }

  /** The model's answer with the real names back ("Patient A" → the full name). Not for "the patient". */
  restore(text: string): string {
    let out = text;
    const labelled = this.people.filter((p) => p.label !== "the patient").sort((a, b) => b.label.length - a.label.length);
    for (const { identity, label } of labelled) out = out.replace(new RegExp(`\\b${label}\\b`, "g"), identity.fullName);
    return out;
  }
}

/** One patient's text as it may leave the clinic: their name "the patient", their numbers and e-mail out. */
export function deidentify(text: string, patient: Identity | null | undefined, keep: string[] = []): string {
  return new Pseudonyms(patient ? [patient] : [], { single: true, keep }).scrub(text);
}

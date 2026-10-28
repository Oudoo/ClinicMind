import type { Gender } from "@prisma/client";

/**
 * The core demo seed's clinical vocabulary and the pure rules that keep it
 * plausible (no database, no randomness of its own: the seed hands in its
 * PRNG's `pick`, and src/__tests__/seed.consistency.test.ts drives the same
 * functions):
 *
 *  - conditions and comorbidities respect the patient's sex: PCOS, hirsutism
 *    treated with laser and melasma only for women; androgenetic alopecia and
 *    hair transplants for either, worded per sex (female-pattern hair loss is
 *    not treated with finasteride, men's acne does not flare before
 *    menstruation);
 *  - a patient's allergies never conflict with the condition's medications:
 *    a penicillin allergy rules out cephalosporins (cephalexin after a hair
 *    transplant) as well as penicillins, a sulfa allergy the sulfonamides, an
 *    NSAID allergy the NSAIDs and salicylates.
 *
 * The seed draws exactly the random numbers it always drew: a patient whose
 * old assignment was already plausible keeps it, an implausible one is
 * re-assigned from the same number (to a condition seen by the same kind of
 * doctor), and medications draw as many start dates as before. Names, ages
 * and phones of the deterministic demo stay as they were, and so does the
 * rest of its random stream.
 */

/** A type alias (not an interface) so it stays assignable to Prisma's JSON input. */
export type SeedMedication = {
  name: string;
  dosage: string;
  frequency: string;
};

type ClinicalText = Pick<Condition, "chronic" | "diagnosis" | "meds" | "symptoms" | "tests" | "followUps">;

export interface Condition {
  key: string;
  tag: string;
  chronic: string[];
  diagnosis: string;
  meds: SeedMedication[];
  reasons: string[];
  symptoms: string[];
  tests: string[];
  followUps: string[];
  doctor: "derm" | "hair";
  /** Set when the condition only occurs in women; either sex otherwise. */
  only?: "FEMALE";
  /** What differs for a woman / a man (the rest is shared). */
  female?: Partial<ClinicalText>;
  male?: Partial<ClinicalText>;
}

export const CONDITIONS: Condition[] = [
  {
    key: "aga",
    tag: "hair-loss",
    chronic: ["Androgenetic alopecia"],
    diagnosis: "Androgenetic alopecia (Norwood III vertex)",
    meds: [
      { name: "Minoxidil 5% solution", dosage: "1 ml", frequency: "Twice daily" },
      { name: "Finasteride", dosage: "1 mg", frequency: "Once daily" },
    ],
    reasons: ["Hair loss consultation", "Hair loss follow-up", "PRP session", "Hair transplant consultation"],
    symptoms: ["progressive thinning at the crown", "increased shedding over 8 months", "family history on father's side"],
    tests: ["Trichoscopy", "Ferritin and TSH"],
    followUps: ["Review in 3 months with photos", "Discuss transplant candidacy"],
    doctor: "hair",
    // Female-pattern hair loss: Ludwig scale, topical minoxidil, no finasteride (teratogenic).
    female: {
      chronic: ["Female pattern hair loss"],
      diagnosis: "Female pattern hair loss (Ludwig I)",
      meds: [{ name: "Minoxidil 5% foam", dosage: "Half a capful", frequency: "Once daily" }],
      symptoms: ["diffuse thinning along the central parting", "increased shedding over 8 months", "family history on mother's side"],
      tests: ["Trichoscopy", "Ferritin, TSH and vitamin D"],
    },
  },
  {
    key: "fue",
    tag: "hair-transplant",
    chronic: ["Androgenetic alopecia"],
    diagnosis: "Post FUE hair transplant, day 7 review",
    meds: [
      { name: "Cephalexin", dosage: "500 mg", frequency: "Twice daily for 5 days" },
      { name: "Saline spray", dosage: "As directed", frequency: "Every 2 hours while awake" },
    ],
    reasons: ["Post-op day 7 review", "Post-op day 14 review", "Month 1 review", "Month 3 review"],
    symptoms: ["mild crusting in recipient area", "no bleeding", "donor area healing well"],
    tests: [],
    followUps: ["Crust removal guidance", "Photo set at month 1"],
    doctor: "hair",
    female: { chronic: ["Female pattern hair loss"] },
  },
  {
    key: "acne",
    tag: "acne",
    chronic: [],
    diagnosis: "Acne vulgaris, moderate inflammatory",
    meds: [
      { name: "Adapalene 0.1% gel", dosage: "Thin layer", frequency: "Nightly" },
      { name: "Doxycycline", dosage: "100 mg", frequency: "Once daily for 8 weeks" },
    ],
    reasons: ["Acne consultation", "Acne follow-up", "Chemical peel session"],
    symptoms: ["inflammatory papules on cheeks and jawline", "post-inflammatory marks", "flares before menstruation"],
    tests: [],
    followUps: ["Review in 6 weeks", "Sunscreen counselling"],
    doctor: "derm",
    male: { symptoms: ["inflammatory papules on cheeks, jawline and back", "post-inflammatory marks", "flares with heat and sweating"] },
  },
  {
    key: "melasma",
    tag: "pigmentation",
    chronic: ["Melasma"],
    diagnosis: "Melasma, mixed epidermal-dermal",
    meds: [
      { name: "Tranexamic acid", dosage: "250 mg", frequency: "Twice daily" },
      { name: "Hydroquinone 4% cream", dosage: "Thin layer", frequency: "Nightly" },
      { name: "Broad-spectrum sunscreen SPF 50", dosage: "Generous", frequency: "Every 3 hours outdoors" },
    ],
    reasons: ["Pigmentation consultation", "Melasma follow-up", "Laser session"],
    symptoms: ["symmetrical brown patches on cheeks", "worse after summer", "no new medications"],
    tests: ["Wood's lamp examination"],
    followUps: ["Review in 8 weeks with photos"],
    doctor: "derm",
    only: "FEMALE",
  },
  {
    key: "eczema",
    tag: "eczema",
    chronic: ["Atopic dermatitis"],
    diagnosis: "Atopic dermatitis flare, flexural",
    meds: [
      { name: "Emollient cream", dosage: "Liberal", frequency: "Twice daily" },
      { name: "Mometasone 0.1% cream", dosage: "Thin layer", frequency: "Once daily for 7 days" },
    ],
    reasons: ["Eczema flare", "Eczema review"],
    symptoms: ["itchy patches in elbow folds", "sleep disturbed by itching", "dry skin"],
    tests: [],
    followUps: ["Review in 2 weeks", "Written skincare plan"],
    doctor: "derm",
  },
  {
    key: "psoriasis",
    tag: "psoriasis",
    chronic: ["Plaque psoriasis"],
    diagnosis: "Plaque psoriasis, limited, elbows and scalp",
    meds: [
      { name: "Calcipotriol/betamethasone gel", dosage: "Thin layer", frequency: "Once daily" },
      { name: "Coal tar shampoo", dosage: "As directed", frequency: "Three times weekly" },
    ],
    reasons: ["Psoriasis review", "Psoriasis consultation"],
    symptoms: ["well-demarcated scaly plaques on elbows", "scalp scaling", "no joint pain"],
    tests: [],
    followUps: ["Review in 6 weeks"],
    doctor: "derm",
  },
  {
    key: "rosacea",
    tag: "rosacea",
    chronic: ["Rosacea"],
    diagnosis: "Papulopustular rosacea",
    meds: [
      { name: "Metronidazole 0.75% gel", dosage: "Thin layer", frequency: "Twice daily" },
      { name: "Ivermectin 1% cream", dosage: "Thin layer", frequency: "Nightly" },
    ],
    reasons: ["Rosacea consultation", "Rosacea follow-up"],
    symptoms: ["persistent central facial redness", "flushing with heat and spicy food", "papules on nose"],
    tests: [],
    followUps: ["Trigger diary", "Review in 8 weeks"],
    doctor: "derm",
  },
  {
    key: "alopecia-areata",
    tag: "hair-loss",
    chronic: ["Alopecia areata"],
    diagnosis: "Alopecia areata, single patch, scalp",
    meds: [{ name: "Intralesional triamcinolone", dosage: "5 mg/ml", frequency: "Every 4 weeks" }],
    reasons: ["Alopecia areata injection", "Alopecia areata review"],
    symptoms: ["round patch of hair loss 3 cm", "noticed 6 weeks ago", "no nail changes"],
    tests: ["Thyroid function"],
    followUps: ["Injection in 4 weeks"],
    doctor: "hair",
  },
  {
    key: "laser-hr",
    tag: "laser",
    chronic: [],
    diagnosis: "Hirsutism, cosmetic laser hair removal course",
    meds: [],
    reasons: ["Laser hair removal session", "Laser hair removal consultation"],
    symptoms: ["unwanted facial hair", "previous waxing", "no hormonal symptoms"],
    tests: ["Hormonal profile if cycles irregular"],
    followUps: ["Next session in 6 weeks"],
    doctor: "derm",
    only: "FEMALE",
  },
  {
    key: "warts",
    tag: "minor-procedure",
    chronic: [],
    diagnosis: "Plantar warts",
    meds: [{ name: "Salicylic acid 40% plaster", dosage: "Apply", frequency: "Daily" }],
    reasons: ["Wart cryotherapy", "Wart review"],
    symptoms: ["painful lesions on sole", "present for 4 months"],
    tests: [],
    followUps: ["Cryotherapy repeat in 3 weeks"],
    doctor: "derm",
  },
];

/** Allergy sets the seed draws from (most patients have none). */
export const ALLERGY_OPTIONS: readonly string[][] = [[], [], [], ["Penicillin"], ["Sulfa drugs"], ["NSAIDs"], ["Latex"]];

/** Comorbidity sets the seed draws from; PCOS only for women. */
export const COMORBIDITY_OPTIONS: readonly string[][] = [[], [], [], ["Hypertension"], ["Type 2 diabetes"], ["Hypothyroidism"], ["PCOS"], ["Iron deficiency anaemia"]];
const FEMALE_ONLY_COMORBIDITIES = new Set(["PCOS"]);

// ── Sex ──────────────────────────────────────────────────────────────────────

const isFemale = (sex: Gender) => sex === "FEMALE";

/** The conditions a patient of this sex can be given. */
export function conditionsFor(sex: Gender): Condition[] {
  return CONDITIONS.filter((c) => !c.only || (c.only === "FEMALE" && isFemale(sex)));
}

/** The comorbidity sets a patient of this sex can be given. */
export function comorbiditiesFor(sex: Gender): string[][] {
  return COMORBIDITY_OPTIONS.filter((set) => isFemale(sex) || set.every((c) => !FEMALE_ONLY_COMORBIDITIES.has(c))).map((set) => [...set]);
}

/** The condition as written for this patient: the shared text with the per-sex differences applied. */
export function conditionFor(cond: Condition, sex: Gender): Condition {
  const variant = isFemale(sex) ? cond.female : sex === "MALE" ? cond.male : undefined;
  return { ...cond, ...variant };
}

// ── Allergies and medications ─────────────────────────────────────────────────

export type DrugClass = "penicillin" | "cephalosporin" | "sulfonamide" | "nsaid" | "salicylate";
export type AllergyClass = "penicillin" | "sulfa" | "nsaid";

const DRUG_CLASSES: readonly { cls: DrugClass; pattern: RegExp }[] = [
  { cls: "penicillin", pattern: /\b(penicillin|amoxicillin|ampicillin|flucloxacillin|cloxacillin|dicloxacillin|piperacillin|co-amoxiclav|augmentin)/i },
  { cls: "cephalosporin", pattern: /\b(ceph|cef)[a-z]*/i },
  { cls: "sulfonamide", pattern: /\b(sulfamethoxazole|co-trimoxazole|cotrimoxazole|sulfasalazine|sulfadiazine|sulfacetamide|dapsone)/i },
  { cls: "nsaid", pattern: /\b(ibuprofen|diclofenac|naproxen|ketoprofen|celecoxib|etoricoxib|mefenamic|indomethacin|meloxicam|piroxicam|ketorolac|aspirin)/i },
  { cls: "salicylate", pattern: /\b(salicylic acid|salicylate|aspirin)/i },
];

/**
 * Which drug classes an allergy rules out. A penicillin allergy is treated as
 * ruling out the cephalosporins too (cross-reactivity), and an NSAID allergy
 * the salicylates (aspirin sensitivity).
 */
const CONFLICTS: Record<AllergyClass, readonly DrugClass[]> = {
  penicillin: ["penicillin", "cephalosporin"],
  sulfa: ["sulfonamide"],
  nsaid: ["nsaid", "salicylate"],
};

export function allergyClass(allergy: string): AllergyClass | null {
  if (/penicillin|amoxicillin|beta-?lactam/i.test(allergy)) return "penicillin";
  if (/sulfa|sulph|sulfonamide/i.test(allergy)) return "sulfa";
  if (/nsaid|ibuprofen|aspirin|diclofenac|naproxen|إيبوبروفين/i.test(allergy)) return "nsaid";
  return null;
}

export function drugClasses(medication: string): DrugClass[] {
  return DRUG_CLASSES.filter((d) => d.pattern.test(medication)).map((d) => d.cls);
}

/** The medications (by name) that one of the allergies rules out. */
export function conflictingMedications(allergies: readonly string[], medications: readonly string[]): string[] {
  const ruledOut = new Set(allergies.flatMap((a) => {
    const cls = allergyClass(a);
    return cls ? CONFLICTS[cls] : [];
  }));
  return medications.filter((m) => drugClasses(m).some((c) => ruledOut.has(c)));
}

/** The allergy sets compatible with the condition's medications (as written for the patient). */
export function allergyOptionsFor(cond: Condition): string[][] {
  const meds = cond.meds.map((m) => m.name);
  return ALLERGY_OPTIONS.filter((set) => conflictingMedications(set, meds).length === 0).map((set) => [...set]);
}

// ── The seed's draws ──────────────────────────────────────────────────────────

/** What the seed's `pick(xs)` returns for the random number `u` (0 ≤ u < 1). */
const at = <T,>(xs: readonly T[], u: number): T => xs[Math.min(xs.length - 1, Math.floor(u * xs.length))]!;
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The patient's condition from one random number: the condition that number
 * has always picked from the full list when it fits the patient's sex;
 * otherwise one that does, seen by the same kind of doctor (so the
 * appointment book built from it stays as it was). Worded for the patient.
 */
export function conditionFromDraw(sex: Gender, u: number): Condition {
  const drawn = at(CONDITIONS, u);
  const eligible = conditionsFor(sex);
  if (eligible.includes(drawn)) return conditionFor(drawn, sex);
  const sameDoctor = eligible.filter((c) => c.doctor === drawn.doctor);
  return conditionFor(at(sameDoctor.length ? sameDoctor : eligible, u), sex);
}

/** The allergies from one random number: the set it has always picked when it fits the condition's medications, otherwise one that does. */
export function allergiesFromDraw(cond: Condition, u: number): string[] {
  const drawn = at(ALLERGY_OPTIONS, u);
  if (!conflictingMedications(drawn, cond.meds.map((m) => m.name)).length) return [...drawn];
  return at(allergyOptionsFor(cond), u);
}

/** The comorbidities from one random number: the set it has always picked when it fits the patient's sex, otherwise one that does. */
export function comorbiditiesFromDraw(sex: Gender, u: number): string[] {
  const drawn = at(COMORBIDITY_OPTIONS, u);
  const options = comorbiditiesFor(sex);
  return options.some((o) => sameSet(o, drawn)) ? [...drawn] : at(options, u);
}

/**
 * Start dates (days ago) of the patient's medications. `draw` is called as
 * many times as the seed has always called it for this condition draw (the
 * medications of the condition `u` picks from the full list), so every later
 * random number in the demo is unchanged; a condition with more medications
 * reuses the last date.
 */
export function medicationStartDays(cond: Condition, u: number, draw: () => number): number[] {
  const drawn = Array.from({ length: at(CONDITIONS, u).meds.length }, () => draw());
  return cond.meds.map((_, i) => drawn[Math.min(i, drawn.length - 1)] ?? 30);
}

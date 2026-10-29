import type { SafetyFinding } from "../types";
import {
  AGE_RULES,
  ALLERGY_CROSS_RULES,
  ALLERGY_GROUPS,
  ALLERGY_TERMS,
  CHILDBEARING_AGE,
  CLASS_LABELS,
  CLASS_PLURALS,
  CONDITIONS,
  CONDITION_RULES,
  DUPLICATE_CLASSES,
  INTERACTIONS,
  routeGroup,
  type DrugClass,
  type Ingredient,
  type Matcher,
  type PregnancyLevel,
  type RouteGroup,
  type Severity,
} from "./knowledge";
import {
  containsTokens,
  dailyDose,
  formatMg,
  identifyMedication,
  matchAliases,
  normaliseText,
  tokenize,
  type IdentifiedMedication,
  type MedicationText,
} from "./identify";

/**
 * Prescribing safety checks: a pure rule engine over the knowledge table.
 *
 * Given the patient (sex, date of birth, pregnancy when known), their
 * documented allergies and conditions, the medications they already take and
 * the medications being prescribed, it returns findings — "stop" (needs a
 * typed reason to override) or "warn" (needs acknowledging) — each naming the
 * medicine and the reason in plain English. Only the proposed medications are
 * checked; the active list is the context they are checked against.
 */

export interface PrescribingPatient {
  gender?: string | null;
  dateOfBirth?: Date | string | null;
  /** true: pregnant · false: pregnancy excluded · null/undefined: unknown. */
  pregnant?: boolean | null;
  /** A recent weight in kg (per-kilogram doses); null/undefined: not known. */
  weightKg?: number | null;
}

export interface PrescribingInput {
  patient: PrescribingPatient;
  allergies: readonly string[];
  conditions: readonly string[];
  activeMedications: readonly MedicationText[];
  proposed: readonly MedicationText[];
  /** Reference time for the patient's age (tests). */
  now?: Date;
}

interface Resolved {
  med: MedicationText;
  label: string;
  source: "proposed" | "active";
  index: number;
  id: IdentifiedMedication;
  group: RouteGroup;
  keys: Set<string>;
  classes: Set<DrugClass>;
}

const SYSTEMIC_ONLY: readonly RouteGroup[] = ["systemic"];

export function checkPrescribing(input: PrescribingInput): SafetyFinding[] {
  const now = input.now ?? new Date();
  const proposed = input.proposed.filter((m) => m.name.trim()).map((m, i) => resolve(m, "proposed", i));
  const active = input.activeMedications.filter((m) => m.name.trim()).map((m, i) => resolve(m, "active", i));
  if (!proposed.length) return [];

  const patient = describePatient(input.patient, input.conditions, now);
  const findings: SafetyFinding[] = [];
  const push = (f: SafetyFinding) => findings.push(f);

  const allergies = input.allergies.map(parseAllergy).filter((a): a is ParsedAllergy => a !== null);
  const conditions = matchConditions(input.conditions);

  for (const p of proposed) {
    allergyFindings(p, allergies).forEach(push);
    const pregnancy = pregnancyFinding(p, patient);
    if (pregnancy) push(pregnancy);
    ageFindings(p, patient).forEach(push);
    doseFindings(p, patient).forEach(push);
    conditionFindings(p, conditions).forEach(push);
  }
  duplicateFindings(proposed, active).forEach(push);
  interactionFindings(proposed, active).forEach(push);

  return order(dedupe(findings), proposed);
}

// ── Medications ──────────────────────────────────────────────────────────────

function resolve(med: MedicationText, source: Resolved["source"], index: number): Resolved {
  const id = identifyMedication(med);
  const classes = new Set<DrugClass>();
  for (const ingredient of id.ingredients) for (const c of ingredient.classes) classes.add(c);
  return {
    med,
    label: med.name.trim().replace(/\s+/g, " "),
    source,
    index,
    id,
    group: routeGroup(id.route),
    keys: new Set(id.ingredients.map((i) => i.key)),
    classes,
  };
}

function matches(r: Resolved, m: Matcher, defaultRoutes?: readonly RouteGroup[]): boolean {
  const routes = m.routes ?? defaultRoutes;
  if (routes && !routes.includes(r.group)) return false;
  if (m.notClasses?.some((c) => r.classes.has(c))) return false;
  return Boolean(m.ingredients?.some((k) => r.keys.has(k)) || m.classes?.some((c) => r.classes.has(c)));
}

/** The ingredient of a product that a matcher picked out (for "Augmentin contains amoxicillin"). */
function matchedIngredient(r: Resolved, m: Pick<Matcher, "ingredients" | "classes">): Ingredient | undefined {
  return r.id.ingredients.find((i) => m.ingredients?.includes(i.key) || i.classes.some((c) => m.classes?.includes(c)));
}

/** "Doxycycline", or "Roaccutane 20 mg (isotretinoin)" when the name does not say the generic. */
function named(r: Resolved, ingredient?: Ingredient): string {
  const generic = ingredient ?? (r.id.ingredients.length === 1 ? r.id.ingredients[0] : undefined);
  if (!generic) return r.label;
  const label = normaliseText(r.label);
  const genericName = normaliseText(generic.name).replace(/\s*\(.*\)$/, "");
  return label.includes(genericName) ? r.label : `${r.label} (${genericName})`;
}

function classLabel(c: DrugClass): string {
  return CLASS_LABELS[c] ?? c.replace(/-/g, " ");
}

function classPlural(c: DrugClass): string {
  return CLASS_PLURALS[c] ?? c.replace(/-/g, " ");
}

function finding(
  r: Resolved,
  rule: string,
  severity: Severity,
  message: string,
  detail: Record<string, unknown> = {},
): SafetyFinding {
  return {
    rule,
    severity,
    medication: r.label,
    message,
    detail: { generic: r.id.ingredients.map((i) => i.key), route: r.id.route, ...detail },
  };
}

// ── Patient ──────────────────────────────────────────────────────────────────

interface PatientFacts {
  female: boolean;
  sexKnown: boolean;
  age: number | null;
  childbearing: boolean;
  pregnant: boolean | null;
  pregnancySource: "record" | "condition" | null;
  weightKg: number | null;
}

export function ageInYears(dob: Date | string | null | undefined, now: Date): number | null {
  if (!dob) return null;
  const d = typeof dob === "string" ? new Date(dob) : dob;
  if (Number.isNaN(d.getTime())) return null;
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

/** A recorded condition or diagnosis that says the patient is pregnant ("Pregnant, 12 weeks", "حامل"). */
export function conditionsSayPregnant(conditions: readonly string[]): boolean {
  return conditions.some((c) => {
    const t = normaliseText(c);
    if (/حامل/u.test(t)) return true;
    const m = /\b(pregnant|pregnancy)\b/.exec(t);
    if (!m) return false;
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    if (/(post|after|not|no|non|previous|prior|history of|past|planning|wish(es)? for)[\s-]*$/.test(before)) return false;
    return !/^\s*(test|excluded|ruled out|negative)/.test(after);
  });
}

function describePatient(p: PrescribingPatient, conditions: readonly string[], now: Date): PatientFacts {
  const sex = (p.gender ?? "").toUpperCase();
  const female = sex === "FEMALE";
  const sexKnown = sex === "FEMALE" || sex === "MALE";
  const age = ageInYears(p.dateOfBirth, now);
  const childbearing = female && (age === null || (age >= CHILDBEARING_AGE.from && age <= CHILDBEARING_AGE.to));
  let pregnant = p.pregnant ?? null;
  let pregnancySource: PatientFacts["pregnancySource"] = pregnant === null ? null : "record";
  if (pregnant === null && conditionsSayPregnant(conditions)) {
    pregnant = true;
    pregnancySource = "condition";
  }
  const weightKg = typeof p.weightKg === "number" && p.weightKg > 0 ? p.weightKg : null;
  return { female, sexKnown, age, childbearing, pregnant, pregnancySource, weightKg };
}

function womanDescription(p: PatientFacts): string {
  return p.age === null ? "The patient is a woman of unknown age" : `The patient is a ${p.age}-year-old woman`;
}

// ── Allergies ────────────────────────────────────────────────────────────────

interface ParsedAllergy {
  text: string;
  /** Ingredients named in the allergy. */
  ingredients: Map<string, Ingredient>;
  /** Classes named outright ("Penicillin", "Sulfa drugs"). */
  namedClasses: Set<DrugClass>;
  /** Allergy groups of the named ingredients (an allergy to amoxicillin → penicillins). */
  groups: Map<DrugClass, Ingredient>;
  latex: boolean;
}

const NO_ALLERGY = /^(no known|nkda|nka|nkfa|nil|none|no allergies|no drug allergies|no allergy|not known|unknown|denies|لا يوجد|لا توجد|لا)\b/u;

export function parseAllergy(text: string): ParsedAllergy | null {
  const norm = normaliseText(text);
  if (!norm || NO_ALLERGY.test(norm)) return null;
  const tokens = tokenize(norm);
  const namedClasses = new Set<DrugClass>();
  let latex = false;
  for (const term of ALLERGY_TERMS) {
    if (!term.terms.some((t) => containsTokens(tokens, tokenize(t)))) continue;
    term.classes?.forEach((c) => namedClasses.add(c));
    if (term.latex) latex = true;
  }
  const ingredients = new Map<string, Ingredient>();
  const groups = new Map<DrugClass, Ingredient>();
  for (const target of matchAliases(tokens)) {
    for (const ingredient of target.ingredients) {
      ingredients.set(ingredient.key, ingredient);
      for (const c of ingredient.classes) if (ALLERGY_GROUPS[c] && !groups.has(c)) groups.set(c, ingredient);
    }
  }
  if (!namedClasses.size && !ingredients.size && !latex) return null;
  return { text: text.trim(), ingredients, namedClasses, groups, latex };
}

function allergyFindings(p: Resolved, allergies: readonly ParsedAllergy[]): SafetyFinding[] {
  const out: SafetyFinding[] = [];
  for (const a of allergies) {
    const quoted = `“${a.text}”`;
    // 1. The very ingredient is documented.
    const same = p.id.ingredients.find((i) => a.ingredients.has(i.key));
    if (same) {
      out.push(finding(p, "allergy.direct", "stop", `${named(p, same)}: the patient has a documented allergy to ${same.name.toLowerCase()} (${quoted}).`, { allergy: a.text }));
      continue;
    }
    // 2. A class named in the allergy ("Penicillin", "NSAIDs").
    const namedClass = [...p.classes].find((c) => a.namedClasses.has(c) && ALLERGY_GROUPS[c]);
    if (namedClass) {
      const ingredient = matchedIngredient(p, { classes: [namedClass] });
      out.push(finding(p, "allergy.direct", "stop", `${named(p, ingredient)} is ${classLabel(namedClass)}, and the patient has a documented allergy to ${classPlural(namedClass)} (${quoted}).`, { allergy: a.text, class: namedClass }));
      continue;
    }
    // 3. Another member of the group of an ingredient the patient reacted to.
    const groupClass = [...p.classes].find((c) => a.groups.has(c));
    if (groupClass) {
      const culprit = a.groups.get(groupClass)!;
      const ingredient = matchedIngredient(p, { classes: [groupClass] });
      const severity = ALLERGY_GROUPS[groupClass] ?? "warn";
      out.push(finding(p, "allergy.class", severity, `${named(p, ingredient)} is ${classLabel(groupClass)}, like ${culprit.name.toLowerCase()}, to which the patient is allergic (${quoted}); ${classPlural(groupClass)} cross-react.`, { allergy: a.text, class: groupClass, allergen: culprit.key }));
      continue;
    }
    // 4. Cross-reactivity between classes (penicillin → cephalosporins…).
    const allergyClasses = new Set<DrugClass>([...a.namedClasses, ...a.groups.keys()]);
    const cross = ALLERGY_CROSS_RULES.find((rule) => allergyClasses.has(rule.allergy) && matches(p, rule.drug));
    if (cross) {
      const drugClass = cross.drug.classes?.find((c) => p.classes.has(c));
      const ingredient = drugClass ? matchedIngredient(p, { classes: [drugClass] }) : undefined;
      const is = drugClass ? ` is ${classLabel(drugClass)}` : "";
      const allergyName = a.groups.get(cross.allergy)?.name.toLowerCase() ?? classPlural(cross.allergy);
      out.push(finding(p, "allergy.cross-reactivity", cross.severity, `${named(p, ingredient)}${is}; the patient has a documented allergy to ${allergyName} (${quoted}) and ${cross.why}.`, { allergy: a.text, crossReactivity: cross.id }));
      continue;
    }
    // 5. Latex: a warning for procedures and injections only.
    if (a.latex && (p.id.route === "injection" || p.classes.has("procedure"))) {
      out.push(finding(p, "allergy.latex", "warn", `Latex allergy on record (${quoted}): use latex-free gloves and equipment for ${p.label}.`, { allergy: a.text }));
    }
  }
  return out;
}

// ── Pregnancy and sex ────────────────────────────────────────────────────────

/** At most one pregnancy finding per medication: the strongest. */
function pregnancyFinding(p: Resolved, patient: PatientFacts): SafetyFinding | null {
  const candidates: SafetyFinding[] = [];
  const consider = (f: SafetyFinding) => candidates.push(f);
  for (const ingredient of p.id.ingredients) {
    const level: PregnancyLevel | undefined = p.group === "topical" ? ingredient.pregnancy?.topical : ingredient.pregnancy?.systemic;
    const why = ingredient.pregnancy?.why ?? "";
    const drug = named(p, ingredient);
    const detail = { age: patient.age, sex: patient.female ? "FEMALE" : patient.sexKnown ? "MALE" : "UNKNOWN", pregnant: patient.pregnant };
    if (patient.female && ingredient.femaleContraindicated) {
      consider(finding(p, "pregnancy.teratogen", "stop", `${drug} must not be taken by women who are or could become pregnant: ${why}. The patient is female${patient.age === null ? "" : ` (${patient.age})`}. Record why it is needed (for example post-menopausal hair loss) or do not prescribe it.`, detail));
      continue;
    }
    if (!level) continue;
    if (patient.pregnant === true && (patient.female || !patient.sexKnown)) {
      const source = patient.pregnancySource === "condition" ? "recorded as pregnant in her conditions" : "pregnant";
      consider(finding(p, "pregnancy.pregnant", "stop", `${drug} must be avoided in pregnancy: ${why}. The patient is ${source}.`, detail));
    } else if (patient.childbearing) {
      if (level === "teratogen") {
        if (patient.pregnant === false) {
          consider(finding(p, "pregnancy.contraception", "warn", `${drug}: ${why}. Pregnancy has been excluded; make sure she uses effective contraception during and after treatment.`, detail));
        } else {
          consider(finding(p, "pregnancy.teratogen", "stop", `${drug}: ${why}. ${womanDescription(patient)} and pregnancy has not been excluded. Record the negative pregnancy test and her contraception in the reason, or do not prescribe it.`, detail));
        }
      } else {
        consider(finding(p, "pregnancy.caution", "warn", `${drug} should be avoided in pregnancy: ${why}. ${womanDescription(patient)}: check she is not pregnant and uses contraception.`, detail));
      }
    } else if (!patient.sexKnown && level === "teratogen") {
      consider(finding(p, "pregnancy.sex-unknown", "warn", `${drug}: ${why}. The patient's sex is not recorded, so the pregnancy risk could not be checked.`, detail));
    }
  }
  return candidates.find((f) => f.severity === "stop") ?? candidates[0] ?? null;
}

// ── Age ──────────────────────────────────────────────────────────────────────

function ageFindings(p: Resolved, patient: PatientFacts): SafetyFinding[] {
  if (patient.age === null) return [];
  const age = patient.age;
  return AGE_RULES.filter((rule) => age < rule.under && matches(p, rule.drug)).map((rule) =>
    finding(p, `age.${rule.id}`, rule.severity, `${named(p, matchedIngredient(p, rule.drug))}: ${rule.why}. The patient is ${age}.`, { age, under: rule.under }),
  );
}

// ── Dose ─────────────────────────────────────────────────────────────────────

function doseFindings(p: Resolved, patient: PatientFacts): SafetyFinding[] {
  if (p.id.ingredients.length !== 1) return [];
  const ingredient = p.id.ingredients[0]!;
  const dose = dailyDose(p.med);
  const written = [p.med.dosage, p.med.frequency].filter(Boolean).join(", ");

  if (ingredient.weeklyOnly && p.group === "systemic") {
    if (!dose || dose.dosesPerDay === null) {
      if (p.med.frequency?.trim()) return [];
      return [finding(p, "dose.weekly-only", "warn", `${named(p, ingredient)} is taken once a week: write the frequency as “once weekly” and name the day.`, { frequency: p.med.frequency ?? null })];
    }
    if (dose.dosesPerDay > 1 / 7 + 1e-6) {
      return [finding(p, "dose.weekly-only", "stop", `${named(p, ingredient)} is taken once a week, never daily: daily dosing has caused fatal overdoses. Check the frequency (written: “${written}”).`, { dosesPerDay: dose.dosesPerDay })];
    }
    const weekly = dose.perDoseMg * dose.dosesPerDay * 7;
    if (weekly > ingredient.weeklyOnly.maxWeeklyMg + 1e-9) {
      return [finding(p, "dose.max-weekly", "warn", `${named(p, ingredient)} ${formatMg(weekly)} a week is above the usual maximum of ${formatMg(ingredient.weeklyOnly.maxWeeklyMg)} a week.`, { weeklyMg: weekly, maxWeeklyMg: ingredient.weeklyOnly.maxWeeklyMg })];
    }
    return [];
  }

  if (p.id.route !== "oral" || !dose) return [];
  const out: SafetyFinding[] = [];
  // Per kilogram, when the dose is daily and a recent weight is on the record (isotretinoin).
  const perKgChecked = Boolean(ingredient.perKg && patient.weightKg && dose.dosesPerDay !== null);
  if (ingredient.maxDailyMg && dose.dailyMg > ingredient.maxDailyMg + 1e-9) {
    const amount = dose.dosesPerDay === null ? `a single dose of ${formatMg(dose.perDoseMg)}` : `${formatMg(dose.dailyMg)} a day`;
    const note = ingredient.doseNote && !perKgChecked ? ` (${ingredient.doseNote})` : "";
    out.push(
      finding(p, "dose.max-daily", "warn", `${named(p, ingredient)}: ${amount} is above the usual maximum of ${formatMg(ingredient.maxDailyMg)} a day${note}. Check the dose (written: “${written}”).`, {
        dailyMg: dose.dailyMg,
        perDoseMg: dose.perDoseMg,
        dosesPerDay: dose.dosesPerDay,
        maxDailyMg: ingredient.maxDailyMg,
      }),
    );
  }
  if (perKgChecked && ingredient.perKg && patient.weightKg) {
    const mgPerKg = dose.dailyMg / patient.weightKg;
    if (mgPerKg > ingredient.perKg.maxDailyMgPerKg + 1e-9) {
      const perKg = Math.round(mgPerKg * 100) / 100;
      out.push(
        finding(p, "dose.per-kg", "warn", `${named(p, ingredient)}: ${formatMg(dose.dailyMg)} a day is ${perKg} mg/kg a day for ${patient.weightKg} kg, above ${ingredient.perKg.usual}. Check the dose (written: “${written}”).`, {
          dailyMg: dose.dailyMg,
          weightKg: patient.weightKg,
          mgPerKg: perKg,
          maxDailyMgPerKg: ingredient.perKg.maxDailyMgPerKg,
        }),
      );
    }
  }
  return out;
}

// ── Conditions ───────────────────────────────────────────────────────────────

function matchConditions(conditions: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const text of conditions) {
    const t = normaliseText(text);
    if (!t) continue;
    for (const concept of CONDITIONS) {
      if (!found.has(concept.key) && concept.patterns.some((re) => re.test(t))) found.set(concept.key, text.trim());
    }
  }
  return found;
}

function conditionFindings(p: Resolved, conditions: Map<string, string>): SafetyFinding[] {
  const out: SafetyFinding[] = [];
  for (const rule of CONDITION_RULES) {
    const text = conditions.get(rule.condition);
    if (!text || !matches(p, rule.drug)) continue;
    const concept = CONDITIONS.find((c) => c.key === rule.condition)!;
    const why = rule.why.charAt(0).toUpperCase() + rule.why.slice(1);
    out.push(finding(p, `condition.${rule.id}`, rule.severity, `${named(p, matchedIngredient(p, rule.drug))}: the patient has ${concept.label} (“${text}”). ${why}`, { condition: text, conditionKey: concept.key }));
  }
  return out;
}

// ── Duplicates ───────────────────────────────────────────────────────────────

function duplicateFindings(proposed: readonly Resolved[], active: readonly Resolved[]): SafetyFinding[] {
  const out: SafetyFinding[] = [];
  proposed.forEach((p, i) => {
    const partners = [...active, ...proposed.slice(0, i)];
    for (const q of partners) {
      const shared = p.id.ingredients.filter((ing) => q.keys.has(ing.key));
      const fromActive = q.source === "active";
      if (shared.length) {
        // The same line again (same name) is a continuation or a dose change, not a duplicate.
        if (fromActive && normaliseText(p.label) === normaliseText(q.label)) continue;
        const generic = shared.map((s) => s.name.toLowerCase()).join(" and ");
        const merged = fromActive && p.id.key === q.id.key;
        const tail = fromActive
          ? merged
            ? " Signing updates that entry rather than adding a second one; make sure the patient does not use both."
            : " Make sure the patient does not take both."
          : " Remove one of them.";
        const where = fromActive ? `${q.label}, which the patient already takes` : q.label;
        out.push(finding(p, "duplicate.same-drug", "warn", `${p.label} contains ${generic}, the same medicine as ${where}.${tail}`, { other: q.label, otherSource: q.source, shared: shared.map((s) => s.key) }));
        continue;
      }
      for (const dup of DUPLICATE_CLASSES) {
        if (!p.classes.has(dup.cls) || !q.classes.has(dup.cls)) continue;
        if (dup.routes && (!dup.routes.includes(p.group) || !dup.routes.includes(q.group))) continue;
        const where = fromActive ? `${q.label} (already taken)` : q.label;
        out.push(finding(p, "duplicate.same-class", "warn", `${p.label} and ${where} are both ${classPlural(dup.cls)}: ${dup.why}.`, { other: q.label, otherSource: q.source, class: dup.cls }));
        break;
      }
    }
  });
  return out;
}

// ── Interactions ─────────────────────────────────────────────────────────────

function interactionFindings(proposed: readonly Resolved[], active: readonly Resolved[]): SafetyFinding[] {
  const out: SafetyFinding[] = [];
  proposed.forEach((p, i) => {
    const partners = [...active, ...proposed.slice(0, i)];
    for (const q of partners) {
      if (p.id.ingredients.some((ing) => q.keys.has(ing.key))) continue; // the same medicine: a duplicate, not an interaction
      for (const rule of INTERACTIONS) {
        const forward = matches(p, rule.a, SYSTEMIC_ONLY) && matches(q, rule.b, SYSTEMIC_ONLY);
        const backward = !forward && matches(p, rule.b, SYSTEMIC_ONLY) && matches(q, rule.a, SYSTEMIC_ONLY);
        if (!forward && !backward) continue;
        // Name them in the rule's order: "Isotretinoin with Doxycycline".
        const [first, second] = forward ? [p, q] : [q, p];
        const firstName = named(first, matchedIngredient(first, rule.a));
        const secondName = named(second, matchedIngredient(second, rule.b));
        const already = q.source === "active" ? ` (${q.label} is already taken)` : "";
        out.push(finding(p, `interaction.${rule.id}`, rule.severity, `${firstName} with ${secondName}: ${rule.why}${already}`, { interaction: rule.id, other: q.label, otherSource: q.source }));
      }
    }
  });
  return out;
}

// ── Output ───────────────────────────────────────────────────────────────────

function dedupe(findings: SafetyFinding[]): SafetyFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.rule}|${normaliseText(f.medication)}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Stops first, then warnings; within each, in prescription order. */
function order(findings: SafetyFinding[], proposed: readonly Resolved[]): SafetyFinding[] {
  const position = new Map(proposed.map((p) => [normaliseText(p.label), p.index] as const));
  return findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        Number(a.f.severity !== "stop") - Number(b.f.severity !== "stop") ||
        (position.get(normaliseText(a.f.medication)) ?? 0) - (position.get(normaliseText(b.f.medication)) ?? 0) ||
        a.i - b.i,
    )
    .map(({ f }) => f);
}

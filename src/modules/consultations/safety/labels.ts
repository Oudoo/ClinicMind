/**
 * Human labels for prescribing-safety rule ids ("interaction.retinoid-tetracycline"
 * → "Interaction"). Client-safe.
 */

const EXACT: Record<string, string> = {
  "allergy.direct": "Allergy",
  "allergy.class": "Allergy (same class)",
  "allergy.cross-reactivity": "Allergy cross-reactivity",
  "allergy.latex": "Latex allergy",
  "duplicate.same-drug": "Same medicine twice",
  "duplicate.same-class": "Duplicate therapy (same class)",
  "pregnancy.teratogen": "Pregnancy risk (teratogen)",
  "pregnancy.pregnant": "Patient is pregnant",
  "pregnancy.caution": "Avoid in pregnancy",
  "pregnancy.contraception": "Contraception needed",
  "pregnancy.sex-unknown": "Sex not recorded",
  "dose.max-daily": "Dose above the daily maximum",
  "dose.max-weekly": "Dose above the weekly maximum",
  "dose.weekly-only": "Once-weekly medicine",
};

const PREFIX: Record<string, string> = {
  interaction: "Interaction",
  age: "Age",
  condition: "Condition",
  allergy: "Allergy",
  pregnancy: "Pregnancy",
  dose: "Dose",
  duplicate: "Duplicate therapy",
};

export function ruleLabel(rule: string): string {
  return EXACT[rule] ?? PREFIX[rule.split(".")[0] ?? ""] ?? rule;
}

export const SEVERITY_LABEL = { stop: "Stop", warn: "Warning" } as const;

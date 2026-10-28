/**
 * The deterministic question parser (no database, no AI): English and Arabic,
 * "or" / "and" lists, sex, ages, typos, plurals, negation, and the parts that
 * must never be read as criteria.
 */
import { describe, expect, it } from "vitest";
import { describeCriterion, parseCohortQuestion, type Criterion, type ParsedQuestion } from "@/modules/assistant/parser";
import { editDistance, normalizeText, sameWord, tokenize, variants } from "@/modules/assistant/text";

const NOW = new Date("2026-10-28T10:00:00Z"); // a Wednesday, 12:00 in Cairo
const CTX = {
  now: NOW,
  timeZone: "Africa/Cairo",
  tags: ["vip", "new-patient", "hair-loss"],
  doctors: [
    { id: "d-omar", name: "Dr. Omar Fahmy" },
    { id: "d-mariam", name: "Dr. Mariam Tarek" },
    { id: "d-layla", name: "Dr. Layla Hassan" },
  ],
};

const parse = (q: string): ParsedQuestion => parseCohortQuestion(q, CTX);
const kinds = (p: ParsedQuestion) => p.criteria.map((c) => c.kind);
const only = (p: ParsedQuestion, kind: Criterion["kind"]) => {
  const found = p.criteria.filter((c) => c.kind === kind);
  expect(found, `${kind} criteria in "${p.question}"`).toHaveLength(1);
  return found[0]!;
};
const labels = (c: Criterion) => c.terms.map((t) => t.label);

describe("text normalisation", () => {
  it("normalises Arabic spelling variants, digits and case", () => {
    expect(normalizeText("حساسية")).toBe("حساسيه");
    expect(normalizeText("أحمد")).toBe("احمد");
    expect(normalizeText("مستشفى")).toBe("مستشفي");
    expect(normalizeText("٤٠")).toBe("40");
    expect(normalizeText("PeniCillin")).toBe("penicillin");
  });

  it("tokenises numbers, words, Arabic-attached numbers and ranges", () => {
    expect(tokenize("over ٤٠").map((t) => t.norm)).toEqual(["over", "40"]);
    expect(tokenize("فوق ال40").map((t) => t.kind)).toEqual(["word", "number"]);
    expect(tokenize("aged 20-30").map((t) => t.norm)).toEqual(["aged", "20", "-", "30"]);
    expect(tokenize("Ezzat's allergies").map((t) => [t.norm, t.possessive ?? false])).toEqual([
      ["ezzat", true],
      ["allergies", false],
    ]);
    expect(tokenize("penicillin-allergic").map((t) => t.norm)).toEqual(["penicillin", "allergic"]);
  });

  it("matches plurals, the Arabic article and small typos, but not short look-alikes", () => {
    expect(variants("allergies")).toContain("allergy");
    expect(variants("البنسلين")).toContain("بنسلين");
    expect(variants("للبنسلين")).toContain("بنسلين");
    expect(sameWord("penicilin", "penicillin")).toBe(true);
    expect(sameWord("isotretinon", "isotretinoin")).toBe(true);
    expect(sameWord("male", "mole")).toBe(false);
    expect(editDistance("pateints", "patients")).toBe(1);
  });
});

describe("allergy questions", () => {
  it("reads the audit's question: lidocaine OR penicillin, as a list question", () => {
    const p = parse("Which patients have a documented allergy to lidocaine or penicillin?");
    expect(p.intent).toBe("list");
    const c = only(p, "allergy");
    expect(c.match).toBe("any");
    expect(labels(c)).toEqual(["lidocaine", "penicillin"]);
    expect(c.negate).toBe(false);
    expect(p.leftover).toEqual([]);
    expect(p.problems).toEqual([]);
  });

  it("widens a penicillin allergy to the penicillin class (amoxicillin, Augmentin…)", () => {
    const c = only(parse("Which patients are allergic to penicillin?"), "allergy");
    expect(c.terms[0]!.classLabel).toBe("penicillin class");
    const phrases = c.terms[0]!.phrases.map((w) => w.join(" "));
    expect(phrases).toEqual(expect.arrayContaining(["penicillin", "amoxicillin", "augmentin"]));
  });

  it("tolerates typos in the question and plural forms", () => {
    for (const q of ["Who is alergic to penicilin?", "which pateints have allergies to pencillin", "Patients with penicillin-allergy"]) {
      const p = parse(q);
      expect(p.intent, q).toBe("list");
      expect(labels(only(p, "allergy")), q).toEqual(["penicillin"]);
    }
  });

  it("reads a term before the word allergy, and lists of three", () => {
    expect(labels(only(parse("Any patients with a documented penicillin allergy on file?"), "allergy"))).toEqual(["penicillin"]);
    const c = only(parse("Which patients are allergic to penicillin, sulfa or latex?"), "allergy");
    expect(c.terms).toHaveLength(3);
    expect(c.match).toBe("any");
  });

  it("reads 'and' as both", () => {
    const c = only(parse("Which patients are allergic to penicillin and latex?"), "allergy");
    expect(c.match).toBe("all");
    expect(labels(c)).toEqual(["penicillin", "latex"]);
  });

  it("reads Egyptian Arabic, with the article and attached prepositions", () => {
    const p = parse("مين عنده حساسية من البنسلين؟");
    expect(p.language).toBe("ar");
    expect(p.intent).toBe("list");
    expect(labels(only(p, "allergy"))).toEqual(["penicillin"]);
    const both = only(parse("مين اللي عنده حساسية للبنسلين او الليدوكايين"), "allergy");
    expect(labels(both)).toEqual(["penicillin", "lidocaine"]);
    expect(both.terms[0]!.input).toBe("البنسلين");
  });

  it("reads 'no known allergies' as patients with an empty allergy list, in both languages", () => {
    for (const q of ["Which patients have no known allergies?", "مين معندوش حساسية؟"]) {
      const c = only(parse(q), "allergy");
      expect(c.negate, q).toBe(true);
      expect(c.terms[0]!.any, q).toBe(true);
    }
  });

  it("keeps a negated allergy negated (never silently inverted)", () => {
    const c = only(parse("Which patients aren't allergic to penicillin?"), "allergy");
    expect(c.negate).toBe(true);
    expect(describeCriterion(c)).toBe("no recorded allergy to penicillin");
  });

  it("does not take a patient's name for an allergen", () => {
    const p = parse("What are Tarek Ezzat's allergies?");
    const c = only(p, "allergy");
    expect(c.terms[0]!.any).toBe(true);
    expect(p.subject?.words).toEqual(["tarek", "ezzat"]);
  });

  it("reads an allergen it does not know as typed", () => {
    expect(labels(only(parse("Which patients have sesame allergy?"), "allergy"))).toEqual(["sesame"]);
  });
});

describe("conditions and sex", () => {
  it("reads 'which male patients have PCOS' as two criteria", () => {
    const p = parse("Which male patients have PCOS?");
    expect(kinds(p).sort()).toEqual(["condition", "sex"]);
    expect(only(p, "sex").sexes).toEqual(["MALE"]);
    expect(labels(only(p, "condition"))).toEqual(["PCOS"]);
  });

  it("knows the sex words in English and Arabic, singular and plural", () => {
    const cases: [string, "MALE" | "FEMALE"][] = [
      ["Which men have psoriasis?", "MALE"],
      ["List the females with acne", "FEMALE"],
      ["How many women have PCOS?", "FEMALE"],
      ["رجالة عندهم تكيس على المبايض", "MALE"],
      ["الستات اللي عندهم كلف", "FEMALE"],
      ["مين من الذكور عنده صدفية", "MALE"],
      ["اناث عندهم حب الشباب", "FEMALE"],
    ];
    for (const [q, sex] of cases) expect(only(parse(q), "sex").sexes, q).toEqual([sex]);
  });

  it("does not read 'male pattern baldness' or 'حب الشباب' (acne) as a sex or an age", () => {
    const p = parse("Which patients have male pattern baldness?");
    expect(kinds(p)).toEqual(["condition"]);
    expect(labels(only(p, "condition"))).toEqual(["androgenetic alopecia"]);
    const ar = parse("مين عنده حب الشباب؟");
    expect(kinds(ar)).toEqual(["condition"]);
    expect(labels(only(ar, "condition"))).toEqual(["acne"]);
  });

  it("reads synonyms, Arabic names and typos of conditions", () => {
    expect(labels(only(parse("Which women have polycystic ovary syndrome?"), "condition"))).toEqual(["PCOS"]);
    expect(labels(only(parse("كام مريض عنده صدفية؟"), "condition"))).toEqual(["psoriasis"]);
    expect(labels(only(parse("Whcih pateints have psoraisis?"), "condition"))).toEqual(["psoriasis"]);
    expect(labels(only(parse("Which patients have eczema?"), "condition"))).toEqual(["atopic dermatitis"]);
    const dm = parse("Which diabetic patients have melasma?");
    expect(dm.criteria.filter((c) => c.kind === "condition").map((c) => labels(c)[0])).toEqual(["diabetes (any type)", "melasma"]);
  });

  it("does not read 'type 2 diabetes' as an age", () => {
    const p = parse("Which patients have type 2 diabetes?");
    expect(kinds(p)).toEqual(["condition"]);
    expect(labels(only(p, "condition"))).toEqual(["type 2 diabetes"]);
  });

  it("combines two conditions with 'and' as both", () => {
    const c = only(parse("Which patients have diabetes and hypertension?"), "condition");
    expect(c.match).toBe("all");
    expect(c.terms).toHaveLength(2);
  });

  it("reads a surgery as a procedure, even when it is not in the vocabulary", () => {
    expect(labels(only(parse("Which patients had an FUE hair transplant, and how many grafts?"), "procedure"))).toEqual(["hair transplant"]);
    expect(labels(only(parse("Which patients had knee replacement surgery?"), "procedure"))).toEqual(["knee replacement"]);
  });
});

describe("medications", () => {
  it("reads brand and generic names to the same drug", () => {
    for (const q of ["Which patients take Roaccutane?", "Who is currently on isotretinoin, and at what dose?", "مين بياخد روكتان؟", "Who uses roacutane?"]) {
      expect(labels(only(parse(q), "medication")), q).toEqual(["isotretinoin"]);
    }
    expect(parse("Who is currently on isotretinoin, and at what dose?").details).toEqual(["dose"]);
  });

  it("keeps the strength asked for", () => {
    const c = only(parse("Who takes Propecia 1 mg?"), "medication");
    expect(labels(c)).toEqual(["finasteride"]);
    expect(c.terms[0]!.strength).toBe("1 mg");
    expect(describeCriterion(c)).toBe("active medication: Propecia (finasteride) 1 mg");
  });

  it("reads drug classes", () => {
    const c = only(parse("Which patients are on antibiotics?"), "medication");
    expect(c.terms[0]!.classId).toBe("antibiotics");
    expect(c.terms[0]!.phrases.map((w) => w.join(" "))).toEqual(expect.arrayContaining(["doxycycline", "cephalexin"]));
  });

  it("reads 'not on' and the Egyptian negated verb", () => {
    expect(only(parse("Which patients are not on finasteride?"), "medication").negate).toBe(true);
    const c = only(parse("مين مبياخدش فيناسترايد؟"), "medication");
    expect(c.negate).toBe(true);
    expect(labels(c)).toEqual(["finasteride"]);
  });

  it("does not read 'on the waitlist' as a medication", () => {
    const p = parse("Which patients are on the waitlist?");
    expect(p.criteria).toEqual([]);
    expect(p.leftover.map((l) => l.text)).toEqual(["waitlist"]);
  });
});

describe("ages", () => {
  const age = (q: string) => only(parse(q), "age").age!;

  it("reads over / under / between / and over / aged, in completed years", () => {
    expect(age("Which women over 40 have melasma?")).toMatchObject({ min: 41, max: null });
    expect(age("Patients under 18")).toMatchObject({ min: null, max: 17 });
    expect(age("Which patients are between 20 and 30 years old?")).toMatchObject({ min: 20, max: 30 });
    expect(age("Which patients aged 20-30 have acne?")).toMatchObject({ min: 20, max: 30 });
    expect(age("Which patients are 40 and over?")).toMatchObject({ min: 40, max: null });
    expect(age("Which patients are 18 or younger?")).toMatchObject({ min: null, max: 18 });
    expect(age("Which patients are aged 45?")).toMatchObject({ min: 45, max: 45 });
    expect(age("Which patients older than 65 have hypertension?")).toMatchObject({ min: 66 });
    expect(age("Which patients in their 30s have acne?")).toMatchObject({ min: 30, max: 39 });
    expect(age("Which kids have eczema?")).toMatchObject({ max: 17 });
  });

  it("reads Arabic ages with Arabic-Indic digits", () => {
    expect(age("ستات فوق ٤٠ عندهم حساسية من البنسلين")).toMatchObject({ min: 41 });
    expect(age("مرضى تحت 18")).toMatchObject({ max: 17 });
    expect(age("مرضى سنهم بين 20 و30")).toMatchObject({ min: 20, max: 30 });
  });

  it("reports a negated age instead of inverting it", () => {
    const p = parse("Which patients with acne are not over 40?");
    expect(p.problems).toHaveLength(1);
    expect(p.criteria.some((c) => c.kind === "age")).toBe(false);
  });
});

describe("doctors, tags, appointments and visits", () => {
  it("reads a clinician by title and name, in English and Arabic", () => {
    expect(only(parse("Which patients of Dr. Omar Fahmy have acne?"), "doctor").doctors).toEqual([{ id: "d-omar", name: "Dr. Omar Fahmy" }]);
    expect(only(parse("Which patients of Dr. Mariam Tarek have acne?"), "doctor").doctors![0]!.id).toBe("d-mariam");
    expect(only(parse("مرضى د. عمر اللي عندهم حب شباب"), "doctor").doctors![0]!.id).toBe("d-omar");
  });

  it("reports a clinician it does not know rather than dropping the filter", () => {
    const p = parse("Which patients of Dr. Smith have acne?");
    expect(p.problems.map((x) => x.text)).toEqual(["Dr. Smith"]);
    expect(kinds(p)).toEqual(["condition"]);
  });

  it("reads tags written several ways", () => {
    expect(only(parse("Which VIP patients have melasma?"), "tag").tags).toEqual(["vip"]);
    expect(only(parse("Which patients are tagged vip?"), "tag").tags).toEqual(["vip"]);
    expect(only(parse("List #vip patients with acne"), "tag").tags).toEqual(["vip"]);
    expect(only(parse("Which new patients have acne?"), "tag").tags).toEqual(["new-patient"]);
  });

  it("reads appointment windows and their negation", () => {
    expect(only(parse("Which patients have an upcoming appointment?"), "appointment").window).toMatchObject({ label: "upcoming", to: null });
    expect(only(parse("Which patients are coming in tomorrow?"), "appointment").window?.label).toBe("tomorrow");
    expect(only(parse("Which patients with eczema have an appointment next week?"), "appointment").window?.label).toBe("next week");
    expect(only(parse("مين عنده ميعاد بكرة؟"), "appointment").window?.label).toBe("tomorrow");
    const neg = only(parse("Which patients are without an upcoming appointment?"), "appointment");
    expect(neg.negate).toBe(true);
    const today = only(parse("Summarise today's appointments"), "appointment");
    expect(today.window?.label).toBe("today");
  });

  it("reads 'no visit since' in its common forms", () => {
    expect(only(parse("Which patients have no visit since March?"), "lastVisit").cutoff?.before).toBe("2026-02-28T22:00:00.000Z");
    expect(only(parse("Which patients haven't been seen in 6 months?"), "lastVisit").cutoff?.label).toMatch(/6 months/);
    expect(only(parse("Which patients have not been seen since 2026-03-01?"), "lastVisit").cutoff?.label).toBe("no visit since 2026-03-01");
    expect(only(parse("مين مجاش من 3 شهور؟"), "lastVisit").cutoff?.label).toMatch(/3 months/);
    expect(only(parse("Who has never visited?"), "lastVisit").cutoff).toEqual({ before: null, label: "no visit on record" });
  });
});

describe("intent, details, leftovers and problems", () => {
  it("tells list, count, yes/no check and open questions apart", () => {
    expect(parse("How many patients have rosacea?").intent).toBe("count");
    expect(parse("كام مريض عنده صدفية؟").intent).toBe("count");
    expect(parse("Is anyone on isotretinoin?").intent).toBe("list");
    expect(parse("Do any patients have hives?").intent).toBe("list");
    expect(parse("Is Tarek Ezzat on Cephalexin?").intent).toBe("check");
    expect(parse("Summarise today's appointments").intent).toBe("open");
    expect(parse("Compare melasma progress for patients on tranexamic acid").intent).toBe("open");
  });

  it("finds the person a yes/no question is about", () => {
    const p = parse("Is Tarek Ezzat on Cephalexin?");
    expect(p.subject?.text).toBe("Tarek Ezzat");
    expect(labels(only(p, "medication"))).toEqual(["cephalexin"]);
    expect(parse("هل طارق عزت بياخد سيفالكسين؟").subject?.text).toBe("طارق عزت");
    expect(parse("Does Hassan Ezzat have a penicillin allergy?").subject?.text).toBe("Hassan Ezzat");
  });

  it("recognises requested details (dose, what was prescribed, grafts)", () => {
    expect(parse("Who was treated for acne vulgaris and what was prescribed?").details).toEqual(["medications"]);
    expect(parse("Which patients had an FUE hair transplant, and how many grafts?").details).toEqual(["grafts"]);
  });

  it("leaves words it cannot use as leftovers, never as silent filters", () => {
    const p = parse("Which patients with PCOS like football?");
    expect(kinds(p)).toEqual(["condition"]);
    expect(p.leftover.map((l) => l.text)).toEqual(["football"]);
    expect(parse("Which patients are due their month 3 photo set?").leftover.map((l) => l.text)).toEqual(["due their month 3 photo set"]);
  });

  it("reports a time limit it cannot apply instead of dropping it", () => {
    const today = parse("Which patients were treated for acne today?");
    expect(today.problems.map((x) => x.text)).toEqual(["today"]);
    const since = parse("Which patients haven't been seen by Dr. Omar since March?");
    expect(since.problems.map((x) => x.text)).toEqual(["since March"]);
    // …but a time limit on visits and appointments is a criterion
    expect(parse("Which patients have a follow-up next week?").problems).toEqual([]);
    expect(only(parse("Which patients have a follow-up next week?"), "appointment").window?.label).toBe("next week");
  });

  it("reads 'a reaction to <drug>' as an allergy, not as taking the drug", () => {
    const p = parse("Which patients had a reaction to penicillin?");
    expect(kinds(p)).toEqual(["allergy"]);
  });

  it("refuses 'or' between different kinds of criteria", () => {
    const p = parse("Which patients have PCOS or are on metformin?");
    expect(p.problems).toHaveLength(1);
    expect(p.problems[0]!.reason).toMatch(/or/);
  });

  it("describes criteria plainly for the answer and the audit row", () => {
    const p = parse("Which women over 40 are allergic to penicillin or lidocaine?");
    expect(p.criteria.map(describeCriterion)).toEqual(["female", "age over 40 (41 or older)", "allergy to penicillin or lidocaine"]);
  });
});
